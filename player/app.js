/*
 * Session replay player.
 *
 * PLAYER_VERSION follows semver; STORY_SCHEMA is the newest story.json schema this
 * player understands. A story declares its schema with a top-level "schema" key.
 *
 * Generic: everything session-specific comes from events.json (what happened) and
 * story.json (title, setup steps, chapters, commentary cards, outro). All event
 * content is inserted with textContent, except agent Markdown, which goes through
 * marked + DOMPurify.
 *
 * URL parameters: ?static=1 (no animation, everything visible), ?open=all (every
 * accordion open), ?from=N (scroll to the item that holds event N on load).
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var STATIC = params.has('static') && params.get('static') !== '0';
  var OPEN_ALL = params.get('open') === 'all';
  var FROM = params.has('from') ? parseInt(params.get('from'), 10) : null;
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Polling is opt-in per story: story.poll_tools lists the tool names (after
  // mcp__<server>__) whose runs collapse into one "waiting" line; the player
  // assumes no particular MCP server.
  var DEFAULT_POLL_TOOLS = [];
  var DEFAULT_POLL_LABEL = 'checked on progress';
  var DEFAULT_FF_LABEL = 'waiting';
  var POLL_MIN = 3;
  var GAP_DIVIDER_S = 120;
  var MAX_STEP_S = 1.2; // longest pause between two revealed items at 1×
  var MIN_STEP_S = 0.12; // shortest pause, so bursts stay readable
  var TYPE_CPS = 70; // typing speed of user turns at 1×, characters per second
  var TYPE_MIN_S = 0.35;
  var TYPE_MAX_S = 2.6; // longest a single user turn takes to type at 1×
  var READ_LINE = 0.4; // the reading line, as a fraction of viewport height
  // Activity timeline: ordinary gaps count as real seconds up to ACT_GAP_CAP;
  // a wait (a gap longer than WAIT_GAP_S) counts as ACT_WAIT.
  var WAIT_GAP_S = 30;
  var ACT_GAP_MIN = 0.5;
  var ACT_GAP_CAP = 6;
  var ACT_WAIT = 5;
  var FF_S = 1.0; // how long playback takes to fast-forward a wait at 1×
  var SEEK_S = 0.9; // animated jumps (chapter nav, scrubber ticks)

  // ---------------------------------------------------------------- helpers

  var PLAYER_VERSION = '1.0.0';
  var STORY_SCHEMA = 1;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function append(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var c = arguments[i];
      if (c != null) parent.appendChild(c);
    }
    return parent;
  }

  // Plain text with `code` spans, built as DOM nodes (never innerHTML).
  function inlineCode(text) {
    var frag = document.createDocumentFragment();
    String(text == null ? '' : text)
      .split('`')
      .forEach(function (part, i) {
        if (!part) return;
        frag.appendChild(i % 2 ? el('code', null, part) : document.createTextNode(part));
      });
    return frag;
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function firstLine(s) {
    return (
      String(s || '')
        .split('\n')
        .find(function (l) {
          return l.trim();
        }) || ''
    );
  }

  function basename(p) {
    return String(p || '')
      .replace(/\/+$/, '')
      .split('/')
      .pop();
  }

  function endOf(ev) {
    return typeof ev.t_end === 'number' ? ev.t_end : ev.t;
  }

  function humanDuration(s) {
    if (!(s >= 0)) return '';
    if (s < 10) return s.toFixed(1) + ' s';
    if (s < 60) return Math.round(s) + ' s';
    if (s < 3600) {
      var m = Math.floor(s / 60),
        r = Math.round(s - m * 60);
      return r ? m + ' min ' + r + ' s' : m + ' min';
    }
    var h = Math.floor(s / 3600),
      mm = Math.round((s - h * 3600) / 60);
    return mm ? h + ' h ' + mm + ' min' : h + ' h';
  }

  function humanSpan(s) {
    if (s < 60) return Math.max(1, Math.round(s)) + ' s';
    if (s < 5400) return Math.round(s / 60) + ' min';
    return humanDuration(s);
  }

  var timeZone;
  function clock(t, withSeconds) {
    var opts = { hour: '2-digit', minute: '2-digit', hour12: false };
    if (withSeconds) opts.second = '2-digit';
    if (timeZone) opts.timeZone = timeZone;
    return new Date(t * 1000).toLocaleTimeString('en-GB', opts);
  }

  function dateLabel(t) {
    var opts = { year: 'numeric', month: 'long', day: 'numeric' };
    if (timeZone) opts.timeZone = timeZone;
    return new Date(t * 1000).toLocaleDateString('en-GB', opts);
  }

  // YYYY-MM-DD in the story's zone; en-CA formats dates that way.
  function isoDate(t) {
    var opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
    if (timeZone) opts.timeZone = timeZone;
    return new Date(t * 1000).toLocaleDateString('en-CA', opts);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function mcpParts(name) {
    if (typeof name !== 'string' || name.indexOf('mcp__') !== 0) return null;
    var rest = name.slice(5);
    var cut = rest.indexOf('__');
    if (cut < 0) return null;
    return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
  }

  // Undo JSON string escapes in text that is JSON but cut off mid-way, so a
  // truncated payload still reads as code rather than one escaped line.
  function decodeEscapes(s) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, function (_, c) {
      switch (c[0]) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '';
        case 'b':
        case 'f':
          return '';
        case 'u':
          return String.fromCharCode(parseInt(c.slice(1), 16));
        default:
          return c;
      }
    });
  }

  function tryParseJSON(s) {
    if (typeof s !== 'string') return undefined;
    var t = s.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return undefined;
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }

  // Pull long or multi-line strings out of a JSON value so they render as real
  // code blocks; the remaining skeleton shows the structure with a pointer.
  function extractBlocks(value) {
    var blocks = [];
    function walk(v, path, parent) {
      if (typeof v === 'string' && ((v.indexOf('\n') >= 0 && v.length > 60) || v.length > 400)) {
        var label = path || 'value';
        if (parent) {
          var ref = parent.filename || parent.file_path || parent.path || parent.name;
          if (typeof ref === 'string' && ref !== v) label += ' · ' + basename(ref);
        }
        blocks.push({ label: label, text: v });
        return '‹' + label + ' · see below›';
      }
      if (Array.isArray(v))
        return v.map(function (x, i) {
          return walk(x, path + '[' + i + ']', null);
        });
      if (v && typeof v === 'object') {
        var o = {};
        Object.keys(v).forEach(function (k) {
          o[k] = walk(v[k], path ? path + '.' + k : k, v);
        });
        return o;
      }
      return v;
    }
    var skeleton = walk(value, '', null);
    return { skeleton: skeleton, blocks: blocks };
  }

  // ---------------------------------------------------------------- data

  function loadData() {
    if (window.REPLAY_EVENTS && window.REPLAY_STORY) {
      return Promise.resolve({
        events: window.REPLAY_EVENTS,
        story: window.REPLAY_STORY,
      });
    }
    function get(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
        return r.json();
      });
    }
    return Promise.all([get('events.json'), get('story.json')]).then(function (r) {
      return { events: r[0], story: r[1] };
    });
  }

  // A story written for a newer schema may use fields this player ignores or
  // misreads; refuse it rather than render it wrong.
  function checkSchema(d) {
    var schema = d.story.schema == null ? 1 : d.story.schema;
    if (schema > STORY_SCHEMA) {
      throw new Error(
        'story.json uses schema ' +
          schema +
          ', but player ' +
          PLAYER_VERSION +
          ' supports up to schema ' +
          STORY_SCHEMA +
          '. Use a newer player.',
      );
    }
    return d;
  }

  function showLoadError(err) {
    var app = document.getElementById('app');
    app.textContent = '';
    var box = el('div', 'load-error');
    append(
      box,
      el('h1', null, 'The session data could not be loaded'),
      el('p', null, 'This page reads events.json and story.json next to index.html.'),
      append(
        el('p'),
        document.createTextNode('Serve the folder over HTTP (e.g. '),
        el('code', null, 'python3 -m http.server'),
        document.createTextNode('), or run '),
        el('code', null, 'python3 tools/build_site.py'),
        document.createTextNode(' once so that opening index.html from disk works.'),
      ),
      el('pre', null, String(err && err.message ? err.message : err)),
    );
    app.appendChild(box);
  }

  // ---------------------------------------------------------------- model

  function buildModel(events, story) {
    var pollSet = new Set(story.poll_tools || DEFAULT_POLL_TOOLS);
    var n = events.length;

    function isPoll(ev) {
      var p = ev.kind === 'tool' && mcpParts(ev.name);
      return !!p && pollSet.has(p.tool);
    }
    function isToolSearch(ev) {
      return ev.kind === 'tool' && ev.name === 'ToolSearch';
    }

    var cardsAt = new Map();
    (story.cards || []).forEach(function (c) {
      if (!(c.at >= 0 && c.at < n)) {
        console.warn('card anchor out of range:', c);
        return;
      }
      if (!cardsAt.has(c.at)) cardsAt.set(c.at, []);
      cardsAt.get(c.at).push(c);
    });
    var chapterAt = new Map();
    (story.chapters || []).forEach(function (c, i) {
      if (!(c.at >= 0 && c.at < n)) {
        console.warn('chapter anchor out of range:', c);
        return;
      }
      chapterAt.set(c.at, { title: c.title, number: i + 1 });
    });
    var anchors = new Set(Array.from(cardsAt.keys()).concat(Array.from(chapterAt.keys())));

    // Top-level items: one per event, except runs of polling calls, which
    // collapse into one group. A group never swallows an anchored event, so
    // cards and chapters always sit on a visible item.
    var items = [];
    var i = 0;
    while (i < n) {
      var ev = events[i];
      if (isPoll(ev)) {
        var run = [i];
        var k = i + 1;
        while (k < n && !anchors.has(k) && (isPoll(events[k]) || isToolSearch(events[k]))) {
          run.push(k);
          k++;
        }
        while (run.length && !isPoll(events[run[run.length - 1]])) run.pop();
        var polls = run.filter(function (x) {
          return isPoll(events[x]);
        }).length;
        if (polls >= POLL_MIN) {
          var last = run[run.length - 1];
          // Calls can overlap (issued in parallel), so the group ends at the latest end.
          var tEnd = Math.max.apply(
            null,
            run.map(function (x) {
              return endOf(events[x]);
            }),
          );
          items.push({
            type: 'group',
            events: run,
            polls: polls,
            ev0: i,
            t: ev.t,
            tEnd: tEnd,
          });
          i = last + 1;
          continue;
        }
      }
      items.push({
        type: ev.kind,
        events: [i],
        ev0: i,
        t: ev.t,
        tEnd: endOf(ev),
      });
      i++;
    }

    var itemOfEvent = new Array(n);
    items.forEach(function (it, idx) {
      it.events.forEach(function (e) {
        itemOfEvent[e] = idx;
      });
    });

    var t0 = Infinity,
      t1 = -Infinity;
    events.forEach(function (e) {
      t0 = Math.min(t0, e.t);
      t1 = Math.max(t1, endOf(e));
    });

    // The session's main MCP server is the one it called most.
    var serverCounts = new Map();
    events.forEach(function (e) {
      var p = e.kind === 'tool' && mcpParts(e.name);
      if (p) serverCounts.set(p.server, (serverCounts.get(p.server) || 0) + 1);
    });
    var server = null,
      best = 0;
    serverCounts.forEach(function (c, s) {
      if (c > best) {
        best = c;
        server = s;
      }
    });

    return {
      events: events,
      story: story,
      items: items,
      itemOfEvent: itemOfEvent,
      cardsAt: cardsAt,
      chapterAt: chapterAt,
      t0: t0,
      t1: t1,
      server: server,
      pollLabel: story.poll_label || DEFAULT_POLL_LABEL,
      ffLabel: story.ff_label || DEFAULT_FF_LABEL,
    };
  }

  function computeStats(m) {
    var tools = m.events.filter(function (e) {
      return e.kind === 'tool';
    });
    // Generic MCP stats; anything specific to one server (e.g. its services)
    // belongs in the story's stats_extra.
    var servers = new Set();
    var mcpCalls = 0;
    tools.forEach(function (e) {
      var p = mcpParts(e.name);
      if (p) {
        mcpCalls++;
        servers.add(p.server);
      }
    });
    var stats = [
      { label: 'Session length', value: humanSpan(workSeconds(m)) },
      { label: 'Tool calls', value: String(tools.length) },
    ];
    if (mcpCalls) {
      stats.push({
        label: 'MCP calls',
        value: String(mcpCalls),
        sub: Array.from(servers).sort().join(' · '),
      });
    }
    return stats.concat(m.story.stats_extra || []);
  }

  // ---------------------------------------------------------------- render: hero, stats, outro

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = el('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      if (ok) resolve();
      else reject(new Error('copy failed'));
    });
  }

  function renderHero(m) {
    var story = m.story;
    var hero = el('header', 'hero');
    var text = el('div', 'hero-text');
    var badge = el('time', 'date-badge', isoDate(m.t0));
    badge.dateTime = isoDate(m.t0);
    hero.appendChild(badge);
    var eyebrow = el('p', 'eyebrow');
    append(
      eyebrow,
      el('span', 'dot'),
      document.createTextNode('session replay · ' + dateLabel(m.t0)),
    );
    var h1 = el('h1', 'hero-title');
    String(story.title || 'Session replay')
      .split(/\s+/)
      .forEach(function (w, i) {
        if (i) h1.appendChild(document.createTextNode(' '));
        h1.appendChild(el('span', 'w', w));
      });
    h1.appendChild(el('span', 'caret'));
    append(text, eyebrow, h1);
    if (story.subtitle) text.appendChild(append(el('p', 'lede'), inlineCode(story.subtitle)));
    // How the session was run (model, effort, client, mode), as chips.
    var sess = story.session;
    if (sess) {
      var chips = el('ul', 'session-chips');
      chips.setAttribute('aria-label', 'session configuration');
      [
        ['model', sess.model],
        ['effort', sess.effort],
        ['client', sess.client],
        ['mode', sess.mode],
      ].forEach(function (kv) {
        if (!kv[1]) return;
        append(chips, append(el('li'), el('span', 'k', kv[0]), el('span', 'v', kv[1])));
      });
      text.appendChild(chips);
    }
    var setup = story.setup || {};
    if (setup.intro) text.appendChild(append(el('p', 'intro'), inlineCode(setup.intro)));
    var cta = el('a', 'cta');
    cta.href = '#replay';
    append(cta, el('span', null, 'Watch it work'), el('span', 'arrow', '↓'));
    text.appendChild(cta);
    hero.appendChild(text);

    if (setup.steps && setup.steps.length) {
      var fig = el('figure', 'term setup');
      fig.setAttribute('aria-labelledby', 'setup-title');
      var bar = el('div', 'term-bar');
      append(bar, el('span', 'tl'), el('span', 'tl'), el('span', 'tl'));
      var bt = el('em', null, 'how to add it to Claude');
      bt.id = 'setup-title';
      bar.appendChild(bt);
      var ol = el('ol', 'steps');
      setup.steps.forEach(function (s, i) {
        var li = el('li', 'step');
        append(li, el('span', 'step-n', pad2(i + 1)));
        var body = el('div', 'step-body');
        body.appendChild(append(el('p', 'step-label'), inlineCode(s.label)));
        if (s.code) {
          var cmd = el('div', 'cmd');
          var pre = el('pre');
          pre.appendChild(el('code', null, s.code));
          var btn = el('button', 'copy', 'copy');
          btn.type = 'button';
          btn.setAttribute('aria-label', 'Copy: ' + s.code);
          btn.addEventListener('click', function () {
            copyText(s.code).then(
              function () {
                btn.textContent = 'copied';
              },
              function () {
                btn.textContent = 'select & copy';
              },
            );
            setTimeout(function () {
              btn.textContent = 'copy';
            }, 1600);
          });
          append(cmd, pre, btn);
          body.appendChild(cmd);
        }
        if (s.note) body.appendChild(append(el('p', 'step-note'), inlineCode(s.note)));
        li.appendChild(body);
        ol.appendChild(li);
      });
      append(fig, bar, ol);
      hero.appendChild(fig);
    }
    return hero;
  }

  function renderStats(m) {
    var sec = el('section', 'stats');
    sec.setAttribute('aria-label', 'Session at a glance');
    var dl = el('dl', 'stats-grid');
    computeStats(m).forEach(function (s) {
      var cell = el('div', 'stat');
      append(
        cell,
        el('dt', null, s.label),
        append(
          el('dd'),
          el('span', 'stat-v', s.value),
          s.sub ? el('span', 'stat-sub', s.sub) : null,
        ),
      );
      dl.appendChild(cell);
    });
    sec.appendChild(dl);
    return sec;
  }

  function renderOutro(m) {
    var o = m.story.outro;
    var foot = el('footer', 'outro');
    var inner = el('div', 'outro-inner');
    inner.appendChild(el('p', 'outro-k', 'end of replay'));
    var of = renderFigure(o && o.image, 'outro-fig');
    if (of) inner.appendChild(of);
    if (o && o.note) inner.appendChild(append(el('p', 'outro-note'), inlineCode(o.note)));
    if (o && o.links && o.links.length) {
      var ul = el('ul', 'outro-links');
      o.links.forEach(function (l) {
        var a = el('a', null, l.label);
        a.href = l.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        append(ul, append(el('li'), a));
      });
      inner.appendChild(ul);
    }
    // Attribution travels with every site built from this player (MIT notice).
    var credit = el('p', 'credit');
    var author = el('a', null, 'Giordon Stark');
    author.href = 'https://giordonstark.com/';
    author.target = '_blank';
    author.rel = 'noopener noreferrer';
    var repo = el('a', null, 'claude-session-replays');
    repo.href = 'https://github.com/kratsg/claude-session-replays';
    repo.target = '_blank';
    repo.rel = 'noopener noreferrer';
    append(
      credit,
      document.createTextNode('made with '),
      repo,
      document.createTextNode(' · player ' + PLAYER_VERSION + ' © '),
      author,
      document.createTextNode(', MIT'),
    );
    inner.appendChild(credit);
    var top = el('a', 'to-top', '↑ back to the top');
    top.href = '#top';
    inner.appendChild(top);
    foot.appendChild(inner);
    return foot;
  }

  // ---------------------------------------------------------------- render: transcript items

  var markdownReady = false;
  function setupMarkdown() {
    if (!window.marked || !window.DOMPurify) return;
    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    markdownReady = true;
  }

  function renderMarkdown(text) {
    var div = el('div', 'md');
    if (markdownReady) {
      div.innerHTML = window.DOMPurify.sanitize(window.marked.parse(String(text || '')));
    } else {
      // Libraries unavailable (offline): plain text, never raw HTML.
      div.classList.add('md-plain');
      div.textContent = String(text || '');
    }
    return div;
  }

  function turnHeader(who, t, extra) {
    var h = el('div', 'turn-h');
    h.appendChild(el('span', 'who', who));
    (extra || []).forEach(function (x) {
      h.appendChild(x);
    });
    var time = el('time', null, clock(t));
    time.dateTime = new Date(t * 1000).toISOString();
    h.appendChild(time);
    return h;
  }

  function renderUserTurn(ev, interject) {
    var a = el('article', 'item turn user' + (interject ? ' interject' : ''));
    var extra = [];
    if (interject) extra.push(el('span', 'tag tag-int', 'typed mid-task'));
    if (ev.abridged) extra.push(el('span', 'tag', 'abridged'));
    a.appendChild(turnHeader(interject ? 'user · interjection' : 'user', ev.t, extra));
    var body = el('div', 'msg');
    body.appendChild(el('span', 'prompt-mark', interject ? '!' : '›'));
    // The full text always occupies layout (the untyped rest is invisible), so
    // typing never shifts the items below it.
    var text = String(ev.text || '');
    var p = el('p', 'msg-text');
    var typed = el('span', 'typed');
    var caret = el('span', 'type-caret');
    var rest = el('span', 'untyped');
    caret.setAttribute('aria-hidden', 'true');
    rest.setAttribute('aria-hidden', 'true');
    append(p, typed, caret, rest);
    body.appendChild(p);
    a.appendChild(body);
    a._type = { text: text, typed: typed, rest: rest, done: false };
    // Screen readers get the whole message regardless of the animation.
    p.setAttribute('aria-label', text);
    if (STATIC || REDUCED) finishTyping(a);
    else rest.textContent = text;
    return a;
  }

  function typeDuration(text) {
    return Math.min(TYPE_MAX_S, Math.max(TYPE_MIN_S, text.length / TYPE_CPS));
  }

  function finishTyping(node) {
    var st = node._type;
    st.done = true;
    st.typed.textContent = st.text;
    st.rest.textContent = '';
    node.classList.add('is-typed');
  }

  // Type a user turn out character by character; speed scales the duration.
  function typeTurn(node, speed, instant) {
    var st = node._type;
    if (!st || st.done) return;
    st.done = true;
    var dur = instant || !(speed < Infinity) ? 0 : typeDuration(st.text) / speed;
    if (dur < 0.03) {
      finishTyping(node);
      return;
    }
    node.classList.add('is-typing');
    var len = st.text.length;
    var start = performance.now();
    function frame(now) {
      var f = Math.min(1, (now - start) / (dur * 1000));
      var cut = Math.round(f * len);
      st.typed.textContent = st.text.slice(0, cut);
      st.rest.textContent = st.text.slice(cut);
      if (f < 1) requestAnimationFrame(frame);
      else {
        node.classList.remove('is-typing');
        finishTyping(node);
      }
    }
    requestAnimationFrame(frame);
  }

  function renderAgentText(ev) {
    var a = el('article', 'item turn agent');
    a.appendChild(turnHeader('claude', ev.t));
    a.appendChild(renderMarkdown(ev.text));
    return a;
  }

  function mcpArg(inp) {
    if (!inp || typeof inp !== 'object') return '';
    var keys = ['query', 'id', 'job_id', 'constraint', 'label', 'session', 'path', 'url', 'name'];
    for (var i = 0; i < keys.length; i++) {
      var v = inp[keys[i]];
      if (typeof v === 'string' && v) return '("' + truncate(firstLine(v), 56) + '")';
      if (typeof v === 'number') return '(' + v + ')';
    }
    return '';
  }

  function signature(ev) {
    var inp = ev.input && typeof ev.input === 'object' ? ev.input : null;
    var p = mcpParts(ev.name);
    if (p) return { server: p.server, fn: p.tool, arg: mcpArg(inp) };
    var name = String(ev.name || 'tool');
    var arg = '';
    if (inp) {
      switch (name) {
        case 'Bash':
          arg = inp.description || firstLine(inp.command);
          break;
        case 'Write':
        case 'Edit':
        case 'Read':
        case 'NotebookEdit':
          arg = basename(inp.file_path || inp.notebook_path);
          break;
        case 'ToolSearch':
          arg = String(inp.query || '')
            .replace(/^select:/, '')
            .split(',')
            .map(function (q) {
              var mp = mcpParts(q.trim());
              return mp ? mp.tool : q.trim();
            })
            .join(', ');
          if (/^select:/.test(inp.query || '')) arg = 'load ' + arg;
          break;
        case 'WebFetch':
          arg = inp.url;
          break;
        case 'WebSearch':
          arg = inp.query;
          break;
        case 'AskUserQuestion':
          arg = inp.questions && inp.questions[0] && inp.questions[0].question;
          break;
        case 'Task':
        case 'Agent':
          arg = inp.description;
          break;
        default:
          arg = '';
      }
    }
    return {
      server: null,
      fn: name,
      arg: arg ? ' · ' + truncate(firstLine(arg), 80) : '',
    };
  }

  function badge(isError) {
    return el('span', 'badge ' + (isError ? 'err' : 'ok'), isError ? 'error' : 'ok');
  }

  var bodySeq = 0;
  function accordion(cls, buttonParts, renderBody) {
    var wrap = el('div', cls);
    var btn = el('button', 'sig');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    var id = 'acc-' + ++bodySeq;
    btn.setAttribute('aria-controls', id);
    btn.appendChild(el('span', 'chev'));
    buttonParts.forEach(function (p) {
      btn.appendChild(p);
    });
    var body = el('div', 'acc-body');
    body.id = id;
    body.hidden = true;
    append(wrap, btn, body);
    btn._renderBody = renderBody;
    btn._body = body;
    return wrap;
  }

  function toggleAccordion(btn, open) {
    var body = btn._body;
    if (!body) return;
    if (open == null) open = btn.getAttribute('aria-expanded') !== 'true';
    if (open && !body._rendered) {
      body._rendered = true;
      btn._renderBody(body);
    }
    btn.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
    btn.parentNode.classList.toggle('open', open);
  }

  function renderToolLine(ev, idx) {
    var sig = signature(ev);
    var main = el('span', 'sig-main');
    if (sig.server) main.appendChild(el('span', 'srv', '[' + sig.server + ']'));
    append(main, el('span', 'fn', sig.fn), sig.arg ? el('span', 'arg', sig.arg) : null);
    var meta = el('span', 'sig-meta');
    var d = typeof ev.t_end === 'number' ? humanDuration(ev.t_end - ev.t) : '';
    append(meta, d ? el('span', 'dur', d) : null, badge(ev.is_error));
    var wrap = accordion(
      'tool' + (ev.is_error ? ' is-err' : '') + (sig.server ? ' is-mcp' : ''),
      [main, meta],
      function (body) {
        renderToolBody(ev, body);
      },
    );
    wrap.dataset.ev = idx;
    return wrap;
  }

  function codeBlock(label, text, cls) {
    var fig = el('figure', 'blk' + (cls ? ' ' + cls : ''));
    if (label) fig.appendChild(el('figcaption', null, label));
    var pre = el('pre');
    pre.appendChild(el('code', null, text));
    fig.appendChild(pre);
    return fig;
  }

  function jsonOrBlocks(value, container, labelPrefix) {
    var ex = extractBlocks(value);
    var sk = ex.skeleton;
    var isContainer = sk && typeof sk === 'object';
    if (isContainer && Object.keys(sk).length) {
      container.appendChild(codeBlock(null, JSON.stringify(sk, null, 2), 'json'));
    } else if (!isContainer && ex.blocks.length === 0) {
      container.appendChild(codeBlock(labelPrefix, String(sk), 'json'));
    }
    ex.blocks.forEach(function (b) {
      container.appendChild(codeBlock(b.label, b.text));
    });
  }

  function renderInput(ev, box) {
    var inp = ev.input;
    if (typeof inp === 'string') {
      var parsed = tryParseJSON(inp);
      if (parsed !== undefined) inp = parsed;
      else {
        var looksJSON = /^\s*[{[]/.test(inp);
        box.appendChild(
          codeBlock(
            looksJSON ? 'input · too long to keep whole, shown as text' : 'input',
            looksJSON ? decodeEscapes(inp) : inp,
          ),
        );
        return;
      }
    }
    if (!inp || typeof inp !== 'object') {
      box.appendChild(codeBlock('input', String(inp)));
      return;
    }
    var rest = Object.assign({}, inp);
    switch (ev.name) {
      case 'Bash':
        if (typeof inp.command === 'string') {
          box.appendChild(
            codeBlock(inp.description ? '$ ' + inp.description : 'command', inp.command, 'shell'),
          );
          delete rest.command;
          delete rest.description;
        }
        break;
      case 'Write':
        if (typeof inp.content === 'string') {
          box.appendChild(codeBlock('write → ' + (inp.file_path || ''), inp.content));
          delete rest.content;
          delete rest.file_path;
        }
        break;
      case 'Edit':
        if (typeof inp.old_string === 'string') {
          box.appendChild(el('p', 'blk-path', 'edit → ' + (inp.file_path || '')));
          box.appendChild(codeBlock('− replace', inp.old_string, 'del'));
          box.appendChild(codeBlock('+ with', inp.new_string || '', 'add'));
          delete rest.old_string;
          delete rest.new_string;
          delete rest.file_path;
        }
        break;
      default:
        break;
    }
    if (Object.keys(rest).length) jsonOrBlocks(rest, box, 'input');
  }

  function renderToolBody(ev, body) {
    var meta = el('p', 'acc-meta');
    var parts = [ev.name, 'started ' + clock(ev.t, true)];
    if (typeof ev.t_end === 'number') parts.push('took ' + humanDuration(ev.t_end - ev.t));
    meta.textContent = parts.join(' · ');
    body.appendChild(meta);

    var inBox = el('section', 'io io-in');
    inBox.appendChild(el('h4', null, 'input'));
    renderInput(ev, inBox);
    body.appendChild(inBox);

    var outBox = el('section', 'io io-out' + (ev.is_error ? ' is-err' : ''));
    outBox.appendChild(el('h4', null, ev.is_error ? 'result · error' : 'result'));
    var res = ev.result == null ? '' : String(ev.result);
    var scroller = el('div', 'result');
    var parsed = res.length < 400000 ? tryParseJSON(res) : undefined;
    if (parsed !== undefined) {
      jsonOrBlocks(parsed, scroller, '');
    } else if (!res) {
      scroller.appendChild(el('p', 'empty', '(empty result)'));
    } else {
      scroller.appendChild(
        codeBlock(null, /^\s*[{[]/.test(res) ? decodeEscapes(res) : res, 'wrap'),
      );
    }
    outBox.appendChild(scroller);
    body.appendChild(outBox);
  }

  function renderGroup(m, it) {
    var evs = it.events.map(function (i) {
      return m.events[i];
    });
    var errs = evs.filter(function (e) {
      return e.is_error;
    }).length;
    var main = el('span', 'sig-main');
    append(
      main,
      el('span', 'hourglass', '⏳'),
      el(
        'span',
        'fn grp-label',
        m.pollLabel + ' ' + it.polls + '× over ' + humanSpan(it.tEnd - it.t),
      ),
    );
    var meta = el('span', 'sig-meta');
    append(
      meta,
      el('span', 'dur', clock(it.t) + '–' + clock(it.tEnd)),
      errs ? el('span', 'badge warn', errs + (errs > 1 ? ' errors' : ' error')) : badge(false),
    );
    var wrap = accordion('group', [main, meta], function (body) {
      var list = el('div', 'group-list');
      it.events.forEach(function (i) {
        list.appendChild(renderToolLine(m.events[i], i));
      });
      body.appendChild(list);
      if (OPEN_ALL)
        list.querySelectorAll('.sig').forEach(function (b) {
          toggleAccordion(b, true);
        });
    });
    return wrap;
  }

  function renderItem(m, it, idx) {
    var ev = m.events[it.ev0];
    var node;
    switch (it.type) {
      case 'group':
        node = renderGroup(m, it);
        node.classList.add('item');
        break;
      case 'prompt':
        node = renderUserTurn(ev, false);
        break;
      case 'interject':
        node = renderUserTurn(ev, true);
        break;
      case 'text':
        node = renderAgentText(ev);
        break;
      case 'tool':
        node = renderToolLine(ev, it.ev0);
        node.classList.add('item');
        break;
      default:
        node = el('div', 'item note', '[' + it.type + '] ' + truncate(ev.text || '', 200));
    }
    node.dataset.item = idx;
    node.dataset.ev = it.ev0;
    return node;
  }

  // A story image: a plain relative path inside the story folder (no scheme,
  // no leading slash, no ".."), so story.json can't point the page elsewhere.
  function renderFigure(img, cls) {
    if (!img || typeof img.src !== 'string') return null;
    var src = img.src;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(src) || src.indexOf('..') !== -1) return null;
    var fig = el('figure', cls);
    var a = el('a');
    a.href = src;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    var im = el('img');
    im.src = src;
    im.alt = img.alt || '';
    im.loading = 'lazy';
    a.appendChild(im);
    fig.appendChild(a);
    if (img.caption) fig.appendChild(append(el('figcaption'), inlineCode(img.caption)));
    return fig;
  }

  function renderCard(m, card) {
    var c = el('aside', 'card');
    c.dataset.at = card.at;
    c.appendChild(el('p', 'card-k', 'commentary · ' + clock(m.events[card.at].t)));
    c.appendChild(el('h3', null, card.title || ''));
    if (card.body) c.appendChild(append(el('p', 'card-body'), inlineCode(card.body)));
    var cf = renderFigure(card.image, 'card-fig');
    if (cf) c.appendChild(cf);
    return c;
  }

  // ---------------------------------------------------------------- render: replay section

  function renderReplay(m, view) {
    var sec = el('section', 'replay');
    sec.id = 'replay';
    sec.setAttribute('aria-label', 'Session replay');

    // Sticky chapter navigation
    var chapters = Array.from(m.chapterAt.entries()).sort(function (a, b) {
      return a[0] - b[0];
    });
    view.chapters = chapters.map(function (e) {
      return {
        at: e[0],
        item: m.itemOfEvent[e[0]],
        title: e[1].title,
        number: e[1].number,
      };
    });
    var nav = el('nav', 'chapnav');
    nav.setAttribute('aria-label', 'Chapters');
    var navInner = el('div', 'chapnav-inner');
    var now = el('span', 'chap-now');
    view.chapNow = now;
    var ol = el('ol', 'chap-list');
    view.chapButtons = view.chapters.map(function (c) {
      var b = el('button', 'chap-btn');
      b.type = 'button';
      append(b, el('span', 'n', pad2(c.number)), el('span', 't', c.title));
      b.addEventListener('click', function () {
        view.seekItem(c.item, true);
      });
      ol.appendChild(append(el('li'), b));
      return b;
    });
    append(navInner, now, ol);
    var prog = el('div', 'chap-progress');
    var fill = el('span');
    prog.appendChild(fill);
    view.progressFill = fill;
    append(nav, navInner, prog);
    if (view.chapters.length) sec.appendChild(nav);

    var transcript = el('div', 'transcript');
    sec.appendChild(transcript);

    var items = m.items;
    view.itemEls = new Array(items.length);
    view.revealEls = items.map(function () {
      return [];
    });
    view.cardEls = [];

    var seg = null,
      flow = null,
      rail = null;
    var prevEnd = null;
    items.forEach(function (it, idx) {
      var cards = m.cardsAt.get(it.ev0);
      var chapter = m.chapterAt.get(it.ev0);
      var startsSegment = !seg || cards || chapter;

      var divider = null;
      // Time before a user prompt is the human thinking, not work: no divider.
      if (prevEnd != null && it.type !== 'prompt' && it.t - prevEnd > GAP_DIVIDER_S) {
        divider = el('div', 'gap');
        divider.setAttribute('role', 'separator');
        divider.appendChild(el('span', null, '· ' + humanSpan(it.t - prevEnd) + ' later ·'));
        view.revealEls[idx].push(divider);
      }
      prevEnd = Math.max(prevEnd || -Infinity, it.tEnd);

      if (startsSegment) {
        if (divider) transcript.appendChild(divider);
        if (chapter) {
          var ch = el('div', 'chapter');
          ch.id = 'chapter-' + chapter.number;
          append(
            ch,
            el('span', 'ch-n', pad2(chapter.number)),
            el('h2', null, chapter.title),
            el('span', 'ch-t', clock(it.t)),
          );
          ch.dataset.item = idx;
          transcript.appendChild(ch);
          view.revealEls[idx].push(ch);
        }
        seg = el('div', 'seg');
        rail = el('div', 'rail');
        flow = el('div', 'flow');
        append(seg, rail, flow);
        transcript.appendChild(seg);
        if (cards) {
          var stack = el('div', 'rail-stack');
          cards.forEach(function (c) {
            var ce = renderCard(m, c);
            ce._anchorItem = idx;
            stack.appendChild(ce);
            view.cardEls.push(ce);
            view.revealEls[idx].push(ce);
          });
          rail.appendChild(stack);
        } else {
          seg.classList.add('no-card');
        }
      } else if (divider) {
        flow.appendChild(divider);
      }

      var node = renderItem(m, it, idx);
      flow.appendChild(node);
      view.itemEls[idx] = node;
      view.revealEls[idx].push(node);
    });

    return sec;
  }

  // ---------------------------------------------------------------- activity timeline

  // The scrubber runs on "activity" time rather than wall-clock time: each
  // transition from item k to item k+1 gets m.trans[k].len units, which is the
  // real gap capped at ACT_GAP_CAP, or a short fixed ACT_WAIT when the gap is a
  // wait. m.act[k] is item k's position on that axis. Real clock time is
  // interpolated linearly inside each transition, so the clock still covers
  // every real second while waits take little room.
  // Wall-clock span of the session minus the gaps before user prompts (time
  // the human spent reading and replying).
  function workSeconds(m) {
    var total = m.t1 - m.t0;
    for (var k = 1; k < m.items.length; k++) {
      if (m.items[k].type !== 'prompt') continue;
      var prevEnd = -Infinity;
      for (var j = 0; j < k; j++) prevEnd = Math.max(prevEnd, m.items[j].tEnd);
      total -= Math.max(0, m.items[k].t - prevEnd);
    }
    return total;
  }

  function buildTimeline(m) {
    var items = m.items,
      n = items.length;
    var act = new Array(n);
    var trans = [];
    act[0] = 0;
    for (var k = 0; k < n - 1; k++) {
      var gap = Math.max(0, items[k + 1].t - items[k].t);
      // The gap before a user prompt is human think time: it is skipped, not
      // fast-forwarded, so it gets the minimum span and no wait styling.
      var human = items[k + 1].type === 'prompt';
      var wait = !human && gap > WAIT_GAP_S;
      var len = human
        ? ACT_GAP_MIN
        : wait
          ? ACT_WAIT
          : Math.min(ACT_GAP_CAP, Math.max(ACT_GAP_MIN, gap));
      trans.push({
        wait: wait,
        human: human,
        group: items[k].type === 'group',
        gap: gap,
        len: len,
      });
      act[k + 1] = act[k] + len;
    }
    m.act = act;
    m.trans = trans;
    m.actTotal = Math.max(act[n - 1], 1e-6);
  }

  // Activity value → { k: item index, f: fraction of the way to item k+1 }.
  function locate(m, A) {
    var n = m.items.length;
    if (!(A > 0)) return { k: 0, f: 0 };
    if (A >= m.act[n - 1]) return { k: n - 1, f: 0 };
    var lo = 0,
      hi = n - 1,
      k = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (m.act[mid] <= A) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return { k: k, f: (A - m.act[k]) / m.trans[k].len };
  }

  function realTime(m, A) {
    var p = locate(m, A);
    var it = m.items[p.k],
      next = m.items[p.k + 1];
    return next ? it.t + p.f * (next.t - it.t) : it.t;
  }

  // ---------------------------------------------------------------- position state

  // One shared "current position" (an activity value A). Scrolling, the
  // chapter nav, the scrubber, its ticks and playback all set it, and
  // view.render(A) updates every indicator from it: scrubber, clock, chapter
  // label and highlight, progress, fast-forward badge and revealed items.
  function createView(m) {
    var view = {
      m: m,
      n: m.items.length,
      A: 0,
      present: -1, // last item at or above the reading line (-1: none yet)
      playing: false,
      speed: 1,
      driving: null, // running position animation (seek or playback)
      pos: null, // cached document Y of each item's top
    };

    view.positions = function () {
      if (!view.pos) {
        var sy = window.scrollY;
        view.pos = view.itemEls.map(function (e) {
          return e.getBoundingClientRect().top + sy;
        });
      }
      return view.pos;
    };

    view.readLine = function () {
      return window.innerHeight * READ_LINE;
    };

    // Scroll position → activity value, by interpolating the reading line
    // between the tops of the two items it falls between.
    view.fromScroll = function () {
      var pos = view.positions();
      // +1px absorbs scrollTo's rounding, so a seek lands on its item.
      var y = window.scrollY + view.readLine() + 1;
      var n = view.n;
      if (y < pos[0]) return { A: 0, present: -1 };
      var lo = 0,
        hi = n - 1,
        k = 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (pos[mid] <= y) {
          k = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (k >= n - 1) return { A: m.act[n - 1], present: n - 1 };
      var f = Math.min(1, (y - pos[k]) / Math.max(1, pos[k + 1] - pos[k]));
      return { A: m.act[k] + f * m.trans[k].len, present: k };
    };

    // Activity value → the scrollY that puts it on the reading line.
    view.scrollFor = function (A) {
      var pos = view.positions();
      var p = locate(m, A);
      var y = p.k >= view.n - 1 ? pos[view.n - 1] : pos[p.k] + p.f * (pos[p.k + 1] - pos[p.k]);
      return Math.max(0, y - view.readLine());
    };

    return view;
  }

  function navHeight() {
    var nav = document.querySelector('.chapnav');
    return nav ? nav.offsetHeight : 0;
  }

  function setupPosition(view) {
    var m = view.m;
    var bar = document.getElementById('playbar');
    var range = document.getElementById('pb-range');
    var clockEl = document.getElementById('pb-clock');
    var ticks = document.getElementById('pb-ticks');
    var ff = document.getElementById('pb-ff');
    var total = m.actTotal;

    bar.hidden = false;
    document.body.classList.add('has-playbar');
    range.max = String(total);
    range.step = 'any';

    // Compressed waits as hatched spans, chapters as clickable ticks.
    m.trans.forEach(function (tr, k) {
      if (!tr.wait) return;
      var span = el('span', 'wait-span');
      span.style.left = ((m.act[k] / total) * 100).toFixed(3) + '%';
      span.style.width = ((tr.len / total) * 100).toFixed(3) + '%';
      span.title = humanSpan(tr.gap) + ' compressed';
      ticks.appendChild(span);
    });
    view.chapters.forEach(function (c) {
      var tick = el('button', 'tick');
      tick.type = 'button';
      tick.style.left = ((m.act[c.item] / total) * 100).toFixed(3) + '%';
      tick.title = 'Chapter ' + c.number + ': ' + c.title;
      tick.setAttribute('aria-label', tick.title);
      tick.addEventListener('click', function () {
        view.seekItem(c.item, true);
      });
      ticks.appendChild(tick);
    });

    var dragging = false;

    view.render = function (A, present) {
      view.A = A;
      var p = locate(m, A);
      if (present == null) present = p.k;
      if (!dragging) range.value = String(A);
      var t = realTime(m, A);
      clockEl.textContent = clock(t, true);
      range.setAttribute('aria-valuetext', clock(t, true));
      updateChapter(view, present, A / total);
      setPresent(view, present);

      var tr = m.trans[p.k];
      var inWait = present >= 0 && tr && tr.wait && p.f > 0.01 && p.f < 0.99;
      if (inWait) {
        var label =
          '⏩ fast-forwarding ' + humanSpan(tr.gap) + (tr.group ? ' of ' + m.ffLabel : '');
        if (ff.textContent !== label) ff.textContent = label;
      }
      ff.classList.toggle('on', !!inWait);
      bar.classList.toggle('ff', !!inWait);
    };

    // Reading the page: scroll position drives everything, unless an
    // animation is moving the page itself (it renders from A directly).
    function onScroll() {
      if (view.driving) return;
      var s = view.fromScroll();
      view.render(s.A, s.present);
    }
    view.onScroll = onScroll;

    function stopDriving() {
      if (view.driving) {
        view.driving.cancel();
        view.driving = null;
      }
    }

    // Animate A to target over dur seconds, scrolling the page with it.
    function drive(target, dur, ease, done) {
      stopDriving();
      var from = view.A;
      var start = performance.now();
      var job = {
        cancelled: false,
        cancel: function () {
          job.cancelled = true;
        },
      };
      view.driving = job;
      function apply(A) {
        window.scrollTo(0, view.scrollFor(A));
        view.render(A);
      }
      if (!(dur > 0)) {
        view.driving = null;
        apply(target);
        if (done) done();
        return;
      }
      if (REDUCED) {
        // No continuous motion: hold, then jump.
        var timer = setTimeout(function () {
          if (job.cancelled) return;
          view.driving = null;
          apply(target);
          if (done) done();
        }, dur * 1000);
        job.cancel = function () {
          job.cancelled = true;
          clearTimeout(timer);
        };
        return;
      }
      function frame(now) {
        if (job.cancelled) return;
        var f = Math.min(1, (now - start) / (dur * 1000));
        apply(from + (target - from) * ease(f));
        if (f < 1) requestAnimationFrame(frame);
        else {
          view.driving = null;
          if (done) done();
        }
      }
      requestAnimationFrame(frame);
    }
    var linear = function (f) {
      return f;
    };
    var inOut = function (f) {
      return f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
    };

    view.seek = function (A, animate) {
      A = Math.max(0, Math.min(total, A));
      var wasPlaying = view.playing;
      pause();
      drive(A, animate && !REDUCED && !STATIC ? SEEK_S : 0, inOut, function () {
        if (wasPlaying) play();
      });
    };
    view.seekItem = function (idx, animate) {
      view.seek(m.act[idx], animate);
    };

    // ------------------------------------------------ playback

    var playBtn = document.getElementById('pb-play');
    var speedBtns = Array.prototype.slice.call(bar.querySelectorAll('[data-speed]'));

    function setPlaying(p) {
      view.playing = p;
      bar.classList.toggle('playing', p);
      document.body.classList.toggle('playing', p);
      playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
    }

    // Playback length of the transition after item k: waits fast-forward in
    // about FF_S, ordinary gaps keep their real length up to MAX_STEP_S, and a
    // user turn holds until its typing has finished.
    function stepDuration(k) {
      var tr = m.trans[k];
      var s = view.speed;
      var d = tr.wait
        ? FF_S / Math.sqrt(s)
        : Math.min(MAX_STEP_S, Math.max(MIN_STEP_S, tr.gap)) / s;
      var node = view.itemEls[k];
      if (node._type && !REDUCED && !STATIC)
        d = Math.max(d, (typeDuration(node._type.text) + 0.2) / s);
      return d;
    }

    function step() {
      if (!view.playing) return;
      var p = locate(m, view.A);
      if (p.k >= view.n - 1) {
        pause();
        return;
      }
      var d = stepDuration(p.k) * (1 - p.f);
      drive(m.act[p.k + 1], d, linear, step);
    }

    function play() {
      if (view.speed === Infinity) {
        pause();
        drive(total, 0, linear);
        return;
      }
      if (view.A >= total - 1e-6) view.A = 0;
      setPlaying(true);
      step();
    }

    function pause() {
      setPlaying(false);
      stopDriving();
    }

    function toggle() {
      if (view.playing) pause();
      else play();
    }
    view.togglePlay = toggle;
    playBtn.addEventListener('click', toggle);

    speedBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        view.speed = b.dataset.speed === 'inf' ? Infinity : Number(b.dataset.speed);
        speedBtns.forEach(function (o) {
          o.setAttribute('aria-pressed', String(o === b));
        });
        if (view.playing) {
          stopDriving();
          if (view.speed === Infinity) play();
          else step();
        }
      });
    });

    // Dragging the scrubber scrolls the page to the matching point.
    range.addEventListener('pointerdown', function () {
      dragging = true;
    });
    window.addEventListener('pointerup', function () {
      dragging = false;
    });
    range.addEventListener('input', function () {
      var wasPlaying = view.playing;
      stopDriving();
      var A = Number(range.value);
      drive(A, 0, linear);
      if (wasPlaying) step();
    });

    // The reader taking over the scroll pauses playback and cancels seeks.
    function userScrollIntent(e) {
      if (
        e.type === 'keydown' &&
        ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].indexOf(e.key) < 0
      )
        return;
      if (
        e.type === 'keydown' &&
        e.target &&
        e.target.closest &&
        e.target.closest('input, textarea, select')
      )
        return;
      if (view.playing) pause();
      else stopDriving();
    }
    window.addEventListener('wheel', userScrollIntent, { passive: true });
    window.addEventListener('touchstart', userScrollIntent, { passive: true });
    window.addEventListener('keydown', userScrollIntent);

    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      var t = e.target;
      if (
        t &&
        t.closest &&
        t.closest('button, a, input, textarea, select, summary, [contenteditable="true"]')
      )
        return;
      e.preventDefault();
      toggle();
    });

    // Layout changes (accordions, resizes, fonts) move items: re-measure.
    var refreshQueued = false;
    function invalidate() {
      view.pos = null;
      if (refreshQueued) return;
      refreshQueued = true;
      requestAnimationFrame(function () {
        refreshQueued = false;
        if (window.ScrollTrigger) window.ScrollTrigger.refresh();
        else onScroll();
      });
    }
    view.invalidate = invalidate;
    if (window.ResizeObserver)
      new ResizeObserver(invalidate).observe(document.getElementById('app'));
    window.addEventListener('resize', invalidate);

    if (window.gsap && window.ScrollTrigger) {
      window.gsap.registerPlugin(window.ScrollTrigger);
      window.ScrollTrigger.create({
        start: 0,
        end: 'max',
        onUpdate: onScroll,
        onRefresh: onScroll,
      });
    } else {
      window.addEventListener(
        'scroll',
        function () {
          requestAnimationFrame(onScroll);
        },
        { passive: true },
      );
    }
    onScroll();
  }

  // Items at or above the reading line are "present"; later ones are dimmed
  // until the timeline reaches them. User turns type out as they arrive.
  function setPresent(view, present) {
    var old = view.present;
    if (present === old) return;
    view.present = present;
    var lo = Math.min(old, present) + 1,
      hi = Math.max(old, present);
    for (var i = Math.max(0, lo); i <= hi && i < view.n; i++) {
      var future = i > present;
      if (!STATIC)
        view.revealEls[i].forEach(function (e) {
          e.classList.toggle('is-future', future);
        });
    }
    if (present > old) {
      for (var j = Math.max(0, old + 1); j <= present; j++) {
        var node = view.itemEls[j];
        if (!node._type || node._type.done) continue;
        // Turns already scrolled out of sight are shown whole.
        var gone = node.getBoundingClientRect().bottom < navHeight();
        typeTurn(node, view.playing ? view.speed : 1, gone || REDUCED || STATIC);
      }
    }
  }

  function updateChapter(view, idx, frac) {
    var cur = -1;
    view.chapters.forEach(function (c, i) {
      if (c.item <= idx) cur = i;
    });
    if (cur !== view.curChapter) {
      view.curChapter = cur;
      view.chapButtons.forEach(function (b, i) {
        b.classList.toggle('current', i === cur);
        if (i === cur) b.setAttribute('aria-current', 'step');
        else b.removeAttribute('aria-current');
      });
      if (view.chapNow) {
        view.chapNow.textContent =
          cur >= 0
            ? 'chapter ' + (cur + 1) + '/' + view.chapters.length
            : view.chapters.length + ' chapters';
      }
      var cb = view.chapButtons[cur];
      var list = cb && cb.closest('.chap-list');
      if (list && list.scrollWidth > list.clientWidth) {
        list.scrollTo({ left: cb.offsetLeft - 16, behavior: 'auto' });
      }
    }
    if (view.progressFill) {
      view.progressFill.style.transform =
        'scaleX(' + Math.max(0, Math.min(1, frac)).toFixed(4) + ')';
    }
  }

  // ---------------------------------------------------------------- intro motion (GSAP)

  function setupIntroMotion() {
    var gsap = window.gsap;
    var hero = document.querySelector('.hero');
    var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from(hero.querySelector('.eyebrow'), {
      autoAlpha: 0,
      y: 12,
      duration: 0.5,
    })
      .from(
        hero.querySelectorAll('.hero-title .w'),
        { autoAlpha: 0, y: 40, rotateX: -50, duration: 0.8, stagger: 0.06 },
        '-=0.2',
      )
      .from(
        hero.querySelectorAll('.lede, .intro, .cta'),
        { autoAlpha: 0, y: 18, duration: 0.6, stagger: 0.1 },
        '-=0.45',
      );
    var setup = hero.querySelector('.setup');
    if (setup) {
      tl.from(setup, { autoAlpha: 0, y: 40, rotate: 3, duration: 0.9 }, 0.35).from(
        setup.querySelectorAll('.step'),
        { autoAlpha: 0, x: 20, duration: 0.5, stagger: 0.12 },
        '-=0.4',
      );
    }
    gsap.from('.stat', {
      autoAlpha: 0,
      y: 24,
      duration: 0.6,
      stagger: 0.07,
      ease: 'power2.out',
      scrollTrigger: { trigger: '.stats', start: 'top 85%', once: true },
    });
  }

  // ---------------------------------------------------------------- boot

  function boot(data) {
    var events = data.events,
      story = data.story || {};
    if (!Array.isArray(events) || !events.length) throw new Error('events.json holds no events');
    events.forEach(function (e) {
      e.t = Number(e.t);
      if (e.t_end != null) e.t_end = Number(e.t_end);
    });
    timeZone = story.timezone;
    try {
      clock(events[0].t);
    } catch {
      console.warn('ignoring invalid story.timezone', timeZone);
      timeZone = undefined;
    }

    if (story.title) document.title = story.title + ' · session replay';
    setupMarkdown();

    var m = buildModel(events, story);
    buildTimeline(m);
    var view = createView(m);

    var app = document.getElementById('app');
    app.textContent = '';
    var top = el('div');
    top.id = 'top';
    append(app, top, renderHero(m), renderStats(m), renderReplay(m, view), renderOutro(m));
    document.body.classList.toggle('static', STATIC);
    if (!STATIC) {
      // Nothing has happened yet: every item starts in the future.
      view.revealEls.forEach(function (els) {
        els.forEach(function (e) {
          e.classList.add('is-future');
        });
      });
    }

    app.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('button.sig');
      if (!btn || !app.contains(btn)) return;
      toggleAccordion(btn);
    });

    if (OPEN_ALL) {
      app.querySelectorAll('.transcript button.sig').forEach(function (b) {
        toggleAccordion(b, true);
      });
    }

    if (window.gsap && window.ScrollTrigger) window.gsap.registerPlugin(window.ScrollTrigger);
    if (!STATIC && !REDUCED && window.gsap && window.ScrollTrigger) setupIntroMotion();
    setupPosition(view);

    if (FROM != null && FROM >= 0 && FROM < events.length) {
      view.seekItem(m.itemOfEvent[FROM], false);
    }
    window.__replay = view;
  }

  function start() {
    loadData()
      .then(checkSchema)
      .then(boot)
      .catch(function (err) {
        console.error(err);
        showLoadError(err);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

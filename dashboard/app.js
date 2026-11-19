// Token Radar's plain dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, a per-protocol detail drawer with the
// model's own inputs and the protocol's farm plan. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var BOARD = window.RADAR;
  if (!BOARD) return;
  var mount = document.getElementById('board');
  var view = {
    query: '', category: 'all', chain: 'all', minTvl: 0, watchOnly: false, tab: 'pre-token',
    sortKey: 'implied', sortDir: -1, selectedSlug: null,
    lab: { on: false, maxMultiple: BOARD.model.sizeMax, minMultiple: BOARD.model.sizeMin, growthWeight: BOARD.model.growthWeight, maturitySpan: BOARD.model.maturitySpan }
  };

  var moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A dollar figure, shortened past a thousand. */
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return moneyFmt.format(n);
  }

  /** A percentage with its sign. */
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  /** An age in days, in years past a year. */
  function ageText(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // radar-2 in one place: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same
  // arithmetic. The size factor falls log-linearly from sizeMax at $5M TVL to sizeMin at $5B TVL.
  function sizeFactor(tvl, model) {
    var low = Math.log10(model.tvlFloor), high = Math.log10(model.tvlCeiling);
    var t = Math.min(1, Math.max(0, (Math.log10(Math.max(1, tvl)) - low) / (high - low)));
    return model.sizeMax + (model.sizeMin - model.sizeMax) * t;
  }

  /** One row's implied value under `model`, from its own snapshot figures. */
  function impliedFor(row, model) {
    var growth = Math.min(model.growthCap, Math.max(model.growthFloor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growthWeight;
    var age = row.age_days === null || row.age_days === undefined ? model.defaultAgeDays : row.age_days;
    var maturity = model.maturityBase + (Math.min(Math.max(age, 0), model.maturitySpanDays) / model.maturitySpanDays) * model.maturitySpan;
    return Math.max(1, Math.round(row.tvl_usd * sizeFactor(row.tvl_usd, model) * growthMult * maturity));
  }

  /** The model's constants with the sandbox's slider values laid over them. */
  function labConstants() {
    var m = Object.assign({}, BOARD.model);
    m.sizeMax = view.lab.maxMultiple;
    m.sizeMin = view.lab.minMultiple;
    m.growthWeight = view.lab.growthWeight;
    m.maturitySpan = view.lab.maturitySpan;
    return m;
  }

  /** The implied value the board shows: the sandbox's, or board.json's when it is off. */
  function shownImplied(row) { return view.lab.on ? impliedFor(row, labConstants()) : row.implied_value_usd; }

  /** Build a DOM node: attrs for class/text/html/events/attributes, then children. */
  function node(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else if (k === 'html') el.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) el.appendChild(c); });
      else if (typeof child === 'string') el.appendChild(document.createTextNode(child));
      else el.appendChild(child);
    }
    return el;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function firstChain(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }

  function stakeSize(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdDays(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  function farmAction(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }

  function stepLine(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  /** A protocol's six-step farm plan, derived from its own record. */
  function farmPlan(p) {
    var chain = firstChain(p);
    var capital = stakeSize(p);
    var hold = holdDays(p.age_days);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: farmAction(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepLine);
  }

  /** Read the view from the URL: a shared link reopens the same board, filter and detail. */
  function readStateFromUrl() {
    var search = new URLSearchParams(window.location.search);
    if (search.get('view') === 'detail' && search.get('slug')) view.selectedSlug = search.get('slug');
    if (search.get('filter') === 'watchlist') view.watchOnly = true;
    if (search.get('tab') === 'live') view.tab = 'live';
    if (search.get('q')) view.query = search.get('q');
    if (search.get('category')) view.category = search.get('category');
    if (search.get('chain')) view.chain = search.get('chain');
    if (search.get('minTvl')) view.minTvl = Number(search.get('minTvl')) || 0;
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) view.query = params.get('q');
    if (params.get('p')) view.selectedSlug = params.get('p');
    if (params.get('category')) view.category = params.get('category');
  }

  /** Write the view back to the URL hash, so a filtered board is shareable. */
  function writeStateToUrl() {
    var params = new URLSearchParams();
    if (view.query) params.set('q', view.query);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.selectedSlug) params.set('p', view.selectedSlug);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /** The rows the current filters leave standing. */
  function filteredRows() {
    var q = view.query.trim().toLowerCase();
    return BOARD.rows.filter(function (r) {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && !(r.chains || []).includes(view.chain)) return false;
      if (view.minTvl && r.tvl_usd < view.minTvl) return false;
      if (view.watchOnly && !r.watchlist) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  /** The filtered rows in the chosen sort order, ties broken by slug. */
  function orderedRows(list) {
    var key = view.sortKey;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = shownImplied(a); bv = shownImplied(b); }
      if (av < bv) return -view.sortDir;
      if (av > bv) return view.sortDir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  /** The page header: the brand and the snapshot's facts. */
  function topBar() {
    return node('header', { class: 'top' },
      node('div', { class: 'brand' }, node('span', { class: 'mark' }), node('span', { class: 'brand-name', text: 'Token Radar' })),
      node('div', { class: 'top-meta' },
        node('span', { text: 'Snapshot ' + BOARD.as_of }),
        node('span', { text: 'DefiLlama protocol index' }),
        node('span', { text: BOARD.model_version + ' model' })
      )
    );
  }

  /** The lede: what the board covers, and the headline figures. */
  function intro() {
    return node('section', { class: 'lede' },
      node('div', null,
        node('h1', { text: BOARD.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        node('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(BOARD.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + BOARD.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })
      ),
      node('div', { class: 'facts' },
        node('div', { class: 'fact' }, node('span', { text: 'Watchlist covered' }), node('b', { text: BOARD.watchlist_size + ' / ' + BOARD.watchlist_size })),
        node('div', { class: 'fact' }, node('span', { text: 'Pre-token rows scored' }), node('b', { text: String(BOARD.board_size) })),
        node('div', { class: 'fact' }, node('span', { text: 'Early rows below the floor' }), node('b', { text: String(BOARD.early_size) })),
        node('div', { class: 'fact' }, node('span', { text: 'Live-token protocols set aside' }), node('b', { text: String(BOARD.live_size) }))
      )
    );
  }

  /** The search box. */
  function searchBox() {
    var search = node('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.query, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.query = search.value; writeStateToUrl(); draw(); });
    return node('div', { class: 'field' }, node('label', { for: 'q', text: 'Search' }), search);
  }

  /** The category picker, built from the categories the board actually holds. */
  function categoryPicker() {
    var categories = Array.from(new Set(BOARD.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var select = node('select', { id: 'category', 'aria-label': 'Filter by category' },
      node('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return node('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.category = select.value; writeStateToUrl(); draw(); });
    return node('div', { class: 'field' }, node('label', { for: 'category', text: 'Category' }), select);
  }

  /** The chain picker, built from the chains the board actually holds. */
  function chainPicker() {
    var chains = Array.from(new Set(BOARD.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var select = node('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      node('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return node('option', { value: c, text: c, selected: c === view.chain ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.chain = select.value; draw(); });
    return node('div', { class: 'field' }, node('label', { for: 'chain', text: 'Chain' }), select);
  }

  /** The minimum-TVL picker. */
  function tvlPicker() {
    var tvlOptions = [[0, 'Any TVL'], [10000000, '>= $10M'], [50000000, '>= $50M'], [100000000, '>= $100M'], [500000000, '>= $500M'], [1000000000, '>= $1B']];
    var select = node('select', { id: 'minTvl', 'aria-label': 'Minimum TVL' },
      tvlOptions.map(function (o) { return node('option', { value: String(o[0]), text: o[1], selected: o[0] === view.minTvl ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.minTvl = Number(select.value) || 0; draw(); });
    return node('div', { class: 'field' }, node('label', { for: 'minTvl', text: 'Min TVL' }), select);
  }

  /** The watchlist-only toggle. */
  function watchToggle() {
    var wl = node('label', { class: 'check' }, node('input', { type: 'checkbox', checked: view.watchOnly ? 'checked' : null }), ' Watchlist only');
    wl.querySelector('input').addEventListener('change', function (e) { view.watchOnly = e.target.checked; draw(); });
    return node('div', { class: 'field' }, node('span', { class: 'sub', text: 'Scope' }), wl);
  }

  /** The pre-token / live-token tab switch. */
  function tabSwitch() {
    var pre = node('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; draw(); } });
    var live = node('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; draw(); } });
    return node('div', { class: 'field' }, node('span', { class: 'sub', text: 'Token status' }), node('div', { class: 'tabs' }, pre, live));
  }

  /** The filter bar: search, category, chain, TVL, scope and tabs, plus the row count. */
  function filterBar() {
    return node('div', { class: 'controls' },
      searchBox(),
      categoryPicker(),
      chainPicker(),
      tvlPicker(),
      watchToggle(),
      tabSwitch(),
      node('span', { class: 'count', text: view.tab === 'pre-token' ? filteredRows().length + ' rows shown' : BOARD.live.length + ' live-token protocols' })
    );
  }

  /** One sortable column header. */
  function sortCell(key, label) {
    return node('th', { scope: 'col' },
      node('button', { type: 'button', onclick: function () { if (view.sortKey === key) view.sortDir = -view.sortDir; else { view.sortKey = key; view.sortDir = -1; } draw(); } },
        label,
        view.sortKey === key ? node('span', { 'aria-hidden': 'true', text: view.sortDir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  /** The ranked board as a sortable table. */
  function boardPanel() {
    var list = orderedRows(filteredRows());
    if (list.length === 0) {
      return node('div', { class: 'panel' }, node('div', { class: 'empty' },
        node('h2', { text: 'No protocol matches that filter' }),
        node('p', { text: 'Clear the search or pick another category to see the board again.' }),
        node('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.query = ''; view.category = 'all'; writeStateToUrl(); draw(); } })
      ));
    }
    var max = list.reduce(function (m, r) { return Math.max(m, shownImplied(r)); }, 1);
    var tbody = node('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = node('tr', {
        'data-selected': view.selectedSlug === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { showDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(r.slug); } }
      },
        node('td', { class: 'num', text: String(view.lab.on ? (list.indexOf(r) + 1) : r.rank) }),
        node('td', null, node('div', { class: 'name' },
          node('b', { text: r.name }),
          node('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        node('td', { class: 'num', text: money(r.tvl_usd) }),
        node('td', { class: 'num ' + growthClass, text: growth }),
        node('td', { class: 'num', text: ageText(r.age_days) }),
        node('td', null, node('div', { class: 'implied' },
          node('div', { class: 'bar', 'aria-hidden': 'true' }, node('i', { style: 'width:' + Math.max(3, Math.round((shownImplied(r) / max) * 100)) + '%' })),
          node('span', { class: 'num', text: money(shownImplied(r)) })
        )),
        node('td', null, node('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return node('div', { class: 'panel' },
      node('div', { class: 'table-wrap' },
        node('table', null,
          node('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          node('thead', null, node('tr', null,
            sortCell('implied', 'Rank'),
            sortCell('name', 'Protocol'),
            sortCell('tvl', 'TVL'),
            sortCell('growth', '7d'),
            sortCell('age', 'Age'),
            sortCell('implied', 'Implied value'),
            node('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  /** The live-token table: protocols that already trade, with market caps. */
  function livePanel() {
    var tbody = node('tbody');
    BOARD.live.forEach(function (r) {
      tbody.appendChild(node('tr', null,
        node('td', { class: 'num', text: 'live' }),
        node('td', null, node('div', { class: 'name' }, node('b', { text: r.name }), node('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        node('td', { class: 'num', text: money(r.tvl_usd) }),
        node('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        node('td', { class: 'num', text: money(r.mcap_usd) }),
        node('td', null, node('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return node('div', { class: 'panel' },
      node('div', { class: 'table-wrap' },
        node('table', null,
          node('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          node('thead', null, node('tr', null, node('th', { scope: 'col', text: 'Status' }), node('th', { scope: 'col', text: 'Protocol' }), node('th', { scope: 'col', text: 'TVL' }), node('th', { scope: 'col', text: '7d' }), node('th', { scope: 'col', text: 'Market cap' }), node('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  /** One sandbox slider: a label, a range input, and a live recompute. */
  function labSlider(id, label, min, max, step, value, oninput) {
    var input = node('input', { type: 'range', id: id, min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label });
    input.addEventListener('input', function () { oninput(Number(input.value)); draw(); var n = document.getElementById(id); if (n) n.focus(); });
    return node('div', { class: 'slider' }, node('label', { for: id, text: label + ': ' + value }), input);
  }

  /** The model sandbox: four sliders that recompute the ranking live in the browser. */
  function labPanel() {
    var lab = view.lab;
    return node('div', { class: 'sandbox' },
      node('h3', { text: 'Model sandbox — try the assumptions' }),
      node('p', { class: 'sub', text: lab.on ? 'Sandbox active: the board above is recomputed live from these sliders. Board.json carries the radar-2 defaults.' : 'Move a slider to recompute the whole ranking live in your browser. Nothing here changes board.json.' }),
      labSlider('sb-size-max', 'Size multiple at $5M', 0.3, 0.5, 0.01, lab.maxMultiple, function (v) { lab.maxMultiple = v; lab.on = true; }),
      labSlider('sb-size-min', 'Size multiple at $5B', 0.05, 0.25, 0.01, lab.minMultiple, function (v) { lab.minMultiple = v; lab.on = true; }),
      labSlider('sb-growth', 'Growth weight', 0, 1.5, 0.05, lab.growthWeight, function (v) { lab.growthWeight = v; lab.on = true; }),
      labSlider('sb-maturity', 'Maturity range', 0, 1, 0.05, lab.maturitySpan, function (v) { lab.maturitySpan = v; lab.on = true; }),
      node('button', { class: 'button', type: 'button', text: 'Reset to radar-2 defaults', onclick: function () { view.lab = { on: false, maxMultiple: BOARD.model.sizeMax, minMultiple: BOARD.model.sizeMin, growthWeight: BOARD.model.growthWeight, maturitySpan: BOARD.model.maturitySpan }; draw(); } })
    );
  }

  /** The model explainer: the formula, the filter rule, and the sandbox. */
  function modelExplainer() {
    var m = BOARD.model;
    return node('section', { class: 'panel model' },
      node('h2', { text: 'How implied value is computed — radar-2' }),
      node('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      node('div', { class: 'formula' },
        'implied = round( tvl_usd x size_multiple(TVL) x (1 + clamp(change_7d, ' + m.growthFloor + ', ' + m.growthCap + ') / 100 x ' + m.growthWeight + ') x (' + m.maturityBase + ' + min(age_days, ' + m.maturitySpanDays + ') / ' + m.maturitySpanDays + ' x ' + m.maturitySpan + ') )'
      ),
      node('p', { class: 'sub', text: 'size_multiple falls log-linearly from ' + m.sizeMax + ' at $5M TVL to ' + m.sizeMin + ' at $5B TVL. Age is the time since the protocol was first listed; an unlisted age uses ' + m.defaultAgeDays + ' days.' }),
      node('p', { class: 'sub', text: 'Filter rule, applied to every ranked row: out go wrapped, staked and bridged products of a token that already trades — categories Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC and CEX; names with a whole word wrapped, staked or staking; names beginning with Binance, Coinbase, Bybit, Kraken, Bitget, OKX, Bitfinex or Gemini; and names ending in a version marker. That is why Binance staked ETH, WBTC and other wrapped products are not on this board, even though their TVL is large.' }),
      node('p', { class: 'sub', text: 'Implied value is this entry’s own claim, not a price and not make.fun’s. It says what a token would plausibly be worth if the protocol launched one and its record stayed as it is. Live-token protocols are set aside with their market caps shown, never mixed into the ranking.' }),
      labPanel()
    );
  }

  var detailDialog = node('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  detailDialog.addEventListener('close', function () { view.selectedSlug = null; writeStateToUrl(); });

  /** Open the detail drawer for one protocol: its model inputs and its farm plan. */
  function showDetail(slug) {
    var row = BOARD.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selectedSlug = slug;
    writeStateToUrl();
    detailDialog.textContent = '';
    var steps = farmPlan(row);
    detailDialog.appendChild(node('div', { class: 'detail-head' },
      node('div', null,
        node('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + BOARD.board_size }),
        node('h2', { id: 'detail-title', text: row.name }),
        node('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      node('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { detailDialog.close(); } })
    ));
    detailDialog.appendChild(node('section', { class: 'detail-section' },
      node('h3', { text: 'Implied value' }),
      node('div', { class: 'equation' },
        node('div', null, node('span', { text: 'TVL' }), node('b', { class: 'num', text: money(row.tvl_usd) })),
        node('div', null, node('span', { text: 'Seven-day growth' }), node('b', { class: 'num', text: pct(row.change_7d) })),
        node('div', null, node('span', { text: 'Age with no token' }), node('b', { class: 'num', text: ageText(row.age_days) })),
        node('div', null, node('span', { text: 'Size multiple' }), node('b', { class: 'num', text: String(row.size_multiple) })),
        node('div', null, node('span', { text: 'Growth multiplier' }), node('b', { class: 'num', text: String(row.growth_multiplier) })),
        node('div', null, node('span', { text: 'Watchlist' }), node('b', { class: 'num', text: row.watchlist ? 'yes' : 'no' })),
        node('div', null, node('span', { text: 'Maturity multiplier' }), node('b', { class: 'num', text: String(row.maturity_multiplier) })),
        node('div', null, node('span', { text: 'Implied value' }), node('b', { class: 'num', text: money(row.implied_value_usd) }))
      ),
      node('p', { class: 'sub', text: 'Model ' + BOARD.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(impliedFor(row, BOARD.model)) + (impliedFor(row, BOARD.model) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    detailDialog.appendChild(node('section', { class: 'detail-section' },
      node('h3', { text: 'Farm plan' }),
      node('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return node('li', null, node('b', { text: action }), node('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof detailDialog.showModal === 'function') {
      if (!detailDialog.open) detailDialog.showModal();
    } else {
      detailDialog.setAttribute('open', '');
    }
  }

  /** Render the whole page from the current view. */
  function draw() {
    mount.textContent = '';
    var shell = node('div', { class: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    shell.appendChild(filterBar());
    shell.appendChild(view.tab === 'pre-token' ? boardPanel() : livePanel());
    if (view.tab === 'pre-token') shell.appendChild(modelExplainer());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!detailDialog.isConnected) mount.appendChild(detailDialog);
    if (view.selectedSlug) showDetail(view.selectedSlug);
  }

  readStateFromUrl();
  draw();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && detailDialog.open) detailDialog.close();
  });
})();

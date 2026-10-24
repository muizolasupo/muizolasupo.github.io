/*
 * views.js: article view counts from GoatCounter (muizolasupo.goatcounter.com).
 *
 * Every element with a data-views-path attribute (for example the meta line
 * under an article's headline, or an article card) asks GoatCounter's public
 * counter for that page's total and shows "· 1,234 views" once the total
 * reaches MIN_VIEWS. Below the threshold, or if the counter cannot be reached,
 * the element stays hidden, so readers never see a small or broken number.
 *
 * Input:  data-views-path="/articles/<slug>.html" on a hidden element that
 *         contains a .views-n span for the number.
 * Output: the element made visible with the formatted count.
 * Notes:  GoatCounter caches counts for up to four hours, so the figure lags
 *         slightly. Requires "Allow adding visitor counts on your website" to
 *         be enabled in the GoatCounter settings.
 */
(function () {
  'use strict';

  var CODE = 'muizolasupo';   // GoatCounter site code
  var MIN_VIEWS = 50;         // show counts only from this number upward

  var targets = document.querySelectorAll('[data-views-path]');
  if (!targets.length || !window.fetch) return;

  // One request per distinct path, shared by every element that shows it
  var requests = {};
  function countFor(path) {
    if (!requests[path]) {
      var url = 'https://' + CODE + '.goatcounter.com/counter/' + encodeURIComponent(path) + '.json';
      requests[path] = fetch(url)
        .then(function (r) { return r.ok ? r.json() : null; })   // 404 = no visits yet
        .then(function (d) {
          // The API returns a formatted string such as "1,234"; keep the digits only
          return d ? parseInt(String(d.count).replace(/[^0-9]/g, ''), 10) : NaN;
        })
        .catch(function () { return NaN; });
    }
    return requests[path];
  }

  Array.prototype.forEach.call(targets, function (el) {
    countFor(el.getAttribute('data-views-path')).then(function (n) {
      if (!(n >= MIN_VIEWS)) return;                  // also false for NaN
      var slot = el.querySelector('.views-n');
      if (slot) slot.textContent = n.toLocaleString('en-US');
      el.style.display = '';                          // reveal
    });
  });
})();

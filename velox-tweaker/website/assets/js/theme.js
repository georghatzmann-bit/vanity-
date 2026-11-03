/* Runs in <head>, before the page paints: applies the remembered theme (default dark)
 * so there is no flash. Loaded as a normal blocking script on purpose - it is tiny. */
(function () {
  var t = 'dark';
  try { if (localStorage.getItem('velox.site.theme') === 'light') t = 'light'; } catch (e) { /* storage blocked */ }
  var root = document.documentElement;
  root.setAttribute('data-theme', t);
  root.classList.add('js');
})();

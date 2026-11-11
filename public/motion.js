// Runs before first paint: sets <html data-motion="on|off"> from the visitor's
// own choice, falling back to their system "reduce motion" setting.
(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var choice = null;
  try { choice = localStorage.getItem('nexus.motion'); } catch (e) { /* storage blocked */ }
  document.documentElement.dataset.motion = choice === 'on' || choice === 'off' ? choice : (reduce ? 'off' : 'on');
})();

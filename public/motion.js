// Runs before first paint. Animations are on unless the visitor switched them off.
(function () {
  var choice = null;
  try { choice = localStorage.getItem('nexus.motion'); } catch (e) { /* storage blocked */ }
  document.documentElement.dataset.motion = choice === 'off' ? 'off' : 'on';
})();

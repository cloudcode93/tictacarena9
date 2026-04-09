// Helper to calculate multiple level ups correctly
function calculateLevelUp(currentXp, currentLevel, xpToNext, gainedXp) {
  let xp = currentXp + gainedXp;
  let level = currentLevel;
  let nextXp = xpToNext;

  while (xp >= nextXp) {
    xp -= nextXp;
    level += 1;
    nextXp = Math.floor(nextXp * 1.2);
  }

  return { xp, level, xp_to_next: nextXp };
}

module.exports = { calculateLevelUp };

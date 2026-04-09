const { supabaseAdmin } = require('../config/supabase');
const cache = require('../utils/cache');
const { calculateLevelUp } = require('../utils/level');

// Cache achievement definitions (they rarely change) — 5 min TTL
async function getAchievementDefs() {
  return cache.getOrSet('achievement_defs', 300, async () => {
    const { data } = await supabaseAdmin.from('achievements_def').select('*');
    return data || [];
  });
}

async function processMatchAchievements(game, p1, p2, io, roomId) {
  try {
    const defs = await getAchievementDefs();
    if (defs.length === 0) return;

    // Fetch both players' data in PARALLEL (was sequential before)
    const playerIds = game.players.map(p => p.userId);
    const [profilesResult, achievementsResult] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').in('id', playerIds),
      supabaseAdmin.from('user_achievements').select('*').in('user_id', playerIds)
    ]);

    const profiles = {};
    (profilesResult.data || []).forEach(p => profiles[p.id] = p);

    const userAchievements = {};
    (achievementsResult.data || []).forEach(a => {
      if (!userAchievements[a.user_id]) userAchievements[a.user_id] = {};
      userAchievements[a.user_id][a.achievement_id] = a;
    });

    // Process both players in parallel
    await Promise.all(game.players.map(async (player, idx) => {
      const isWinner = game.winner === idx;
      const isDraw = game.winner === -1;
      const prof = profiles[player.userId];
      const progMap = userAchievements[player.userId] || {};

      const updates = [];   // Batch update operations
      const inserts = [];   // Batch insert operations
      const unlocked = [];  // Unlocked achievements for notifications
      let totalXpReward = 0;

      for (const def of defs) {
        if (progMap[def.id]?.unlocked) continue;

        let newProg = progMap[def.id]?.progress || 0;
        let shouldUnlock = false;

        const searchText = (def.name + ' ' + def.description).toLowerCase();
        let increment = 0;
        let isStreak = searchText.includes('streak') || searchText.includes('in a row') || searchText.includes('consecutive');

        if (searchText.includes('win') || searchText.includes('won') || searchText.includes('victory') || searchText.includes('triumph')) {
          if (isWinner) increment = 1;
        } else if (searchText.includes('draw') || searchText.includes('tie') || searchText.includes('stalemate')) {
          if (isDraw) increment = 1;
        } else if (searchText.includes('lose') || searchText.includes('lost') || searchText.includes('defeat')) {
          if (!isWinner && !isDraw) increment = 1;
        } else {
          increment = 1;
        }

        if (isStreak) {
          if (increment > 0) newProg += increment;
          else newProg = 0;
        } else {
          newProg += increment;
        }

        if (newProg >= def.max_progress) {
          newProg = def.max_progress;
          shouldUnlock = true;
        }

        if (progMap[def.id]) {
          if (newProg !== progMap[def.id].progress || shouldUnlock !== progMap[def.id].unlocked) {
            updates.push({
              id: progMap[def.id].id,
              progress: newProg,
              unlocked: shouldUnlock,
              unlocked_at: shouldUnlock ? new Date().toISOString() : null
            });
          }
        } else if (newProg > 0) {
          inserts.push({
            user_id: player.userId,
            achievement_id: def.id,
            progress: newProg,
            unlocked: shouldUnlock,
            unlocked_at: shouldUnlock ? new Date().toISOString() : null
          });
        }

        if (shouldUnlock) {
          unlocked.push(def);
          totalXpReward += (def.xp_reward || 0);
        }
      }

      // Execute all DB operations: batch insert + batch upsert (single round-trip each)
      const ops = [];

      if (inserts.length > 0) {
        ops.push(supabaseAdmin.from('user_achievements').insert(inserts).then(res => { if(res.error) console.error('Insert Error:', res.error); }));
      }

      // Batch all updates into a single upsert call instead of N individual queries
      if (updates.length > 0) {
        ops.push(
          supabaseAdmin.from('user_achievements')
            .upsert(updates, { onConflict: 'id' })
            .then(res => { if(res.error) console.error('Batch Update Error:', res.error); })
        );
      }

      if (totalXpReward > 0 && prof) {
        const { xp: newXp, level: newLevel, xp_to_next: newXpToNext } = calculateLevelUp(prof.xp, prof.level, prof.xp_to_next, totalXpReward);
        ops.push(
          supabaseAdmin.from('profiles')
            .update({ xp: newXp, level: newLevel, xp_to_next: newXpToNext })
            .eq('id', player.userId)
            .then(res => { if(res.error) console.error('Profile Update Error:', res.error); })
        );
      }

      await Promise.all(ops);

      // Send a single consolidated notification for all unlocked achievements
      if (io && unlocked.length > 0) {
        const names = unlocked.map(d => d.name).join(', ');
        const totalXp = unlocked.reduce((s, d) => s + (d.xp_reward || 0), 0);
        io.to(player.userId).emit('notification', {
          type: 'achievement',
          title: `🏆 ${unlocked.length > 1 ? unlocked.length + ' Achievements Unlocked!' : 'Achievement Unlocked!'}`,
          message: `${names} (+${totalXp} XP)`
        });
      }
    }));
  } catch (err) {
    console.error('Error processing match achievements:', err);
  }
}

module.exports = { processMatchAchievements };

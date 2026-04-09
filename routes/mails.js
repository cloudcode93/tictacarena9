const express = require('express');
const router = express.Router();
const { getSupabaseClient } = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Get all mails
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userClient = getSupabaseClient(req.token);
    const { data, error } = await userClient
      .from('mails')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Read a mail
router.put('/:id/read', authMiddleware, async (req, res) => {
  try {
    const userClient = getSupabaseClient(req.token);
    // Fire and don't wait for full response — just send success
    userClient.from('mails').update({ read: true }).eq('id', req.params.id).eq('user_id', req.user.id).then(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Claim mail reward
router.put('/:id/claim', authMiddleware, async (req, res) => {
  try {
    const userClient = getSupabaseClient(req.token);
    const { data: mail, error } = await userClient
      .from('mails')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error) return res.status(400).json({ error: error.message });
    if (!mail) return res.status(404).json({ error: 'Mail not found' });
    if (mail.claimed) return res.status(400).json({ error: 'Already claimed' });

    // Mark as claimed + fetch coins IN PARALLEL (if coins reward exists)
    if (mail.reward_coins > 0) {
      const [, profileResult] = await Promise.all([
        userClient.from('mails').update({ claimed: true, read: true }).eq('id', mail.id),
        userClient.from('profiles').select('coins').eq('id', req.user.id).single()
      ]);

      // Award coins (fire-and-forget for speed)
      const profile = profileResult.data;
      if (profile) {
        userClient.from('profiles').update({ coins: profile.coins + mail.reward_coins }).eq('id', req.user.id).then(() => {});
      }
    } else {
      // No coins reward — just mark claimed
      userClient.from('mails').update({ claimed: true, read: true }).eq('id', mail.id).then(() => {});
    }

    res.json({ success: true, reward_coins: mail.reward_coins, reward_item_name: mail.reward_item_name });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete mail
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const userClient = getSupabaseClient(req.token);
    // Fire-and-forget
    userClient.from('mails').delete().eq('id', req.params.id).eq('user_id', req.user.id).then(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

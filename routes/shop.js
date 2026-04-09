const express = require('express');
const router = express.Router();
const { supabase, getSupabaseClient } = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const cache = require('../utils/cache');

// Get all shop items (public, cached 60s)
router.get('/', async (req, res) => {
  try {
    const items = await cache.getOrSet('shop_items', 60, async () => {
      const { data, error } = await supabase
        .from('shop_items')
        .select('id, name, type, emoji, image_url, price, rarity, active')
        .eq('active', true)
        .order('price', { ascending: true });
      if (error) throw error;
      return data || [];
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's purchased items
router.get('/owned', authMiddleware, async (req, res) => {
  try {
    const userClient = getSupabaseClient(req.token);
    const { data, error } = await userClient
      .from('user_items')
      .select('*, shop_items(*)')
      .eq('user_id', req.user.id);

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Buy an item
router.post('/buy', authMiddleware, async (req, res) => {
  try {
    const { item_id } = req.body;
    const userClient = getSupabaseClient(req.token);

    // Fetch item info + user coins + ownership check ALL IN PARALLEL
    const [itemResult, profileResult, existingResult] = await Promise.all([
      supabase.from('shop_items').select('*').eq('id', item_id).single(),
      userClient.from('profiles').select('coins').eq('id', req.user.id).single(),
      userClient.from('user_items').select('id').eq('user_id', req.user.id).eq('item_id', item_id).maybeSingle()
    ]);

    const item = itemResult.data;
    if (itemResult.error || !item) return res.status(404).json({ error: 'Item not found' });
    if (existingResult.data) return res.status(400).json({ error: 'Item already owned' });

    const profile = profileResult.data;
    if (!profile || profile.coins < item.price) {
      return res.status(400).json({ error: 'Not enough coins' });
    }

    // Deduct coins + add item IN PARALLEL
    const [, buyResult] = await Promise.all([
      userClient.from('profiles').update({ coins: profile.coins - item.price }).eq('id', req.user.id),
      userClient.from('user_items').insert({ user_id: req.user.id, item_id: item_id }).select('*, shop_items(*)').single()
    ]);

    if (buyResult.error) return res.status(400).json({ error: buyResult.error.message });

    res.json({ userItem: buyResult.data, newBalance: profile.coins - item.price });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Equip an item
router.post('/equip', authMiddleware, async (req, res) => {
  try {
    const { item_id } = req.body;
    const userClient = getSupabaseClient(req.token);

    // Get the user_item with shop_item info
    const { data: userItem, error: uiErr } = await userClient
      .from('user_items')
      .select('*, shop_items(*)')
      .eq('user_id', req.user.id)
      .eq('item_id', item_id)
      .single();

    if (uiErr || !userItem) return res.status(404).json({ error: 'Item not owned' });

    const shopItem = userItem.shop_items;

    // BATCH unequip: get all same-type items + unequip all in ONE call instead of N calls
    const { data: sameTypeItems } = await userClient
      .from('user_items')
      .select('id, shop_items!inner(type)')
      .eq('user_id', req.user.id)
      .eq('shop_items.type', shopItem.type)
      .eq('equipped', true);

    // Build all operations in parallel
    const ops = [];

    // Unequip all same-type items in parallel (was sequential loop before)
    if (sameTypeItems && sameTypeItems.length > 0) {
      const idsToUnequip = sameTypeItems.map(i => i.id);
      ops.push(
        userClient.from('user_items').update({ equipped: false }).in('id', idsToUnequip)
      );
    }

    // Equip the new item
    ops.push(
      userClient.from('user_items').update({ equipped: true }).eq('id', userItem.id)
    );

    // Update profile based on item type
    const profileUpdates = {};
    if (shopItem.type === 'avatar') {
      profileUpdates.equipped_avatar_url = shopItem.image_url;
    } else if (shopItem.type === 'frame') {
      profileUpdates.equipped_frame = shopItem.emoji || shopItem.name;
    } else if (shopItem.type === 'skin') {
      profileUpdates.equipped_skin = shopItem.emoji || shopItem.name;
    } else if (shopItem.type === 'effect') {
      profileUpdates.equipped_effect = shopItem.emoji || shopItem.name;
    }

    ops.push(
      userClient.from('profiles').update(profileUpdates).eq('id', req.user.id)
    );

    // Execute ALL operations in parallel
    await Promise.all(ops);

    res.json({ success: true, equipped: shopItem });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

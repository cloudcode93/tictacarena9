require('dotenv').config();
const cluster = require('cluster');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { setupMaster, setupWorker } = require('@socket.io/sticky');
const { createAdapter, setupPrimary } = require('@socket.io/cluster-adapter');
const { setupSocket } = require('./socket');
const { supabase } = require('./config/supabase');

const PORT = process.env.PORT || 3000;

if (cluster.isPrimary) {
  const numCPUs = os.cpus().length;
  console.log(`🚀 Primary cluster (PID: ${process.pid}) starting`);
  console.log(`🧠 Spawning ${numCPUs} worker threads for maximum concurrency...`);

  const httpServer = http.createServer();
  
  // Setup sticky sessions (forverts TCP connections to workers)
  setupMaster(httpServer, { loadBalancingMethod: "least-connection" });
  
  // Setup cluster adapter to synchronize Socket.io cross-processes
  setupPrimary();

  cluster.setupPrimary({ serialization: "advanced" });

  httpServer.listen(PORT, () => {
    console.log(`🎮 Tier-1 Performance TicTacArena server running on http://localhost:${PORT}`);
    console.log(`⚡ Clustered Mode | DDoS Protection | Memory Optimized`);
  });

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker) => {
    console.warn(`⚠️ Worker ${worker.process.pid} died. Respawning...`);
    cluster.fork();
  });

  // DB Keep-awake Ping to prevent cold-starts
  setInterval(async () => {
    try {
      await supabase.from('banners').select('id').limit(1);
    } catch (e) {
      console.warn('Keep-awake ping failed:', e.message);
    }
  }, 4 * 60 * 1000); // 4 minutes

} else {
  // Worker processes

  // === Graceful Error Handling ===
  process.on('uncaughtException', (err) => {
    console.error(`💥 Worker ${process.pid} uncaughtException:`, err.message);
    // Give time for in-flight requests to finish, then exit so cluster respawns
    setTimeout(() => process.exit(1), 3000);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`💥 Worker ${process.pid} unhandledRejection:`, reason);
  });

  const app = express();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: { origin: true, methods: ['GET', 'POST'], credentials: true },
    pingTimeout: 30000,
    pingInterval: 10000,
    maxHttpBufferSize: 1e6,
    perMessageDeflate: { threshold: 1024 },
    transports: ['websocket'],   // WebSocket only for max speed
    allowUpgrades: false
  });

  // Expose io globally for server-health socket count
  global.__io = io;

  // Attach cluster adapter and sticky worker
  io.adapter(createAdapter());
  setupWorker(io);

  // Global DDoS priority limit
  const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 500, // Limit each IP to 500 reqs/min
    standardHeaders: true, 
    legacyHeaders: false,
    message: { error: 'Too many requests. You are being rate limited.' }
  });

  app.use(limiter);
  app.use(compression({
    level: 6,
    threshold: 512,
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    }
  }));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      if (ms > 500) console.warn(`⚠️ Slow request: ${req.method} ${req.originalUrl} — ${ms}ms`);
    });
    next();
  });

  app.use('/frontend', express.static(path.join(__dirname, '..', 'frontend'), {
    maxAge: '7d', etag: true, lastModified: true, immutable: false
  }));

  app.use((req, res, next) => { req.io = io; next(); });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/profile', require('./routes/profile'));
  app.use('/api/shop', require('./routes/shop'));
  app.use('/api/friends', require('./routes/friends'));
  app.use('/api/matches', require('./routes/matches'));
  app.use('/api/leaderboard', require('./routes/leaderboard'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/mails', require('./routes/mails'));
  app.use('/api/achievements', require('./routes/achievements'));
  app.use('/api/banners', require('./routes/banners'));
  app.use('/api/topup', require('./routes/topup'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/admin', require('./routes/admin'));

  const cache = require('./utils/cache');

  app.get('/api/world-chat/history', async (req, res) => {
    try {
      const messages = await cache.getOrSet('world_chat_history', 5, async () => {
        const { data } = await supabase
          .from('world_chat')
          .select('*, profiles:user_id(username, equipped_avatar_url, level)')
          .order('created_at', { ascending: false })
          .limit(50);
        return (data || []).reverse();
      });
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() | 0, worker: process.pid });
  });

  app.get('/', (req, res) => res.redirect('/frontend/login.html'));

  setupSocket(io);
}

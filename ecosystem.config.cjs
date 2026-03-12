module.exports = {
  apps: [
    {
      name: "agentloop-server",
      script: "../agentloop/agentloop-server",
      autorestart: true,
      exp_backoff_restart_delay: 1000,
    },
    {
      name: "agentloop-slack",
      script: "dist/index.js",
      cwd: __dirname,
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      wait_ready: true,
      listen_timeout: 10000,
    },
  ],
};

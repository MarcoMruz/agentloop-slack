module.exports = {
  apps: [
    {
      name: "agentloop-slack",
      script: "dist/index.js",
      cwd: __dirname,
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      wait_ready: true,
      listen_timeout: 10000,
      error_file: "logs/error.log",
      out_file: "logs/out.log",
    },
  ],
};

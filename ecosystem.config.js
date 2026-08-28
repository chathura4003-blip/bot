module.exports = {
  apps: [
    {
      name: "chathu-bot",
      script: "index.js",
      node_args: "--expose-gc --max-old-space-size=1000 --max-semi-space-size=64",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

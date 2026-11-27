module.exports = {
    apps: [{
        name: 'sakura-bot',
        script: './app.js',
        watch: false,
        autorestart: true,
        restart_delay: 3000,
        min_uptime: '10s',
        max_restarts: 1,
        max_memory_restart: '1G',
        env: {
            NODE_ENV: 'production',
            SAKURA_MANAGED_BY_PM2: '1'
        }
    }]
};

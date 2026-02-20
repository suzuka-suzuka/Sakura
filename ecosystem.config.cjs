module.exports = {
    apps: [{
        name: 'sakura-bot',
        script: './app.js',
        watch: false,
        max_memory_restart: '1G',
        env: {
            NODE_ENV: 'production'
        }
    }]
};

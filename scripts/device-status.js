#!/usr/bin/env node
const deviceAgent = require('../services/deviceAgent');

(async () => {
    const command = process.argv[2] || 'status';
    if (command === 'map-touch') {
        console.log(JSON.stringify(await deviceAgent.applyTouchMapping(), null, 2));
    } else {
        console.log(JSON.stringify(await deviceAgent.getStatus(), null, 2));
    }
})().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});

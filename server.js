const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Advanced 9/10 Headshot Accuracy Algorithm
function calculateProSensitivity(ramSize, dpi, playstyle) {
    let baseGeneral = 165;
    let baseRedDot = 155;
    let baseScope2X = 145;
    let baseScope4X = 140;
    let baseSniper = 50;
    let baseFreeLook = 75;

    const ram = parseFloat(ramSize) || 6;
    const customDpi = parseInt(dpi, 10);

    // 1. RAM / Touch Latency Adjustment
    if (ram <= 4) {
        baseGeneral += 20;
        baseRedDot += 15;
    } else if (ram >= 8) {
        baseGeneral -= 10;
        baseRedDot -= 10;
    }

    // 2. DPI Compensation Scaling
    if (customDpi && customDpi > 400) {
        const dpiFactor = (customDpi - 400) / 200;
        baseGeneral = Math.round(baseGeneral - (dpiFactor * 8));
        baseRedDot = Math.round(baseRedDot - (dpiFactor * 6));
    }

    // 3. Playstyle Tuning
    if (playstyle === 'onetap') {
        baseRedDot += 10;
        baseGeneral += 5;
    } else if (playstyle === 'smg') {
        baseGeneral += 15;
        baseRedDot -= 5;
    }

    return {
        general: Math.min(200, Math.max(100, baseGeneral)),
        redDot: Math.min(200, Math.max(90, baseRedDot)),
        scope2x: Math.min(200, Math.max(80, baseScope2X)),
        scope4x: Math.min(200, Math.max(80, baseScope4X)),
        sniper: Math.min(100, Math.max(20, baseSniper)),
        freeLook: Math.min(100, Math.max(40, baseFreeLook)),
        recommendedFireSize: ram <= 4 ? "42% - 46%" : "38% - 42%",
        aimPrecision: "Default"
    };
}

app.post('/api/generate', (req, res) => {
    const { ram, dpi, playstyle } = req.body;
    const config = calculateProSensitivity(ram, dpi, playstyle);
    res.json(config);
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

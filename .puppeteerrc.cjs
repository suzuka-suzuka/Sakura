const fs = require("fs");


const findChromePath = () => {
  const possiblePaths = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  ];

  for (const p of possiblePaths) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      continue;
    }
  }
  return undefined;
};

const executablePath = findChromePath();

module.exports = {
  executablePath,

  defaultArgs: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],

  cacheDirectory: "./.cache/puppeteer",
};

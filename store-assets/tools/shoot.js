const puppeteer = require("puppeteer-core");
const path = require("path");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROMO = "file://" + path.join(__dirname, "..", "promo.html");
const OUT = path.join(__dirname, "..", "screenshots");

async function shootFrame(page, frameId, opts, outFile) {
  await page.evaluate((id) => {
    document.querySelectorAll(".frame").forEach((f) => (f.style.display = "none"));
    document.getElementById(id).style.display = "block";
  }, frameId);

  if (opts.heroState) {
    await page.evaluate((state) => {
      document.documentElement.setAttribute("data-hebi", state);
      const title = document.getElementById("hero-title");
      const sub = document.getElementById("hero-sub");
      const banner = document.getElementById("hero-banner");
      if (state === "off") {
        title.textContent = "Without RTL Fix for AI Chats";
        sub.textContent = "Hebrew flows left-to-right and reads backwards — this is the default";
        banner.style.background = "#52525b";
      } else {
        title.textContent = "With RTL Fix for AI Chats";
        sub.textContent = "Hebrew, Arabic & Persian render correctly — math and code stay untouched";
        banner.style.background = "#4f46e5";
      }
    }, opts.heroState);
  }

  await page.waitForFunction(() => {
    const el = document.querySelector(".frame:not([style*='display: none']) .katex");
    return !!el;
  }, { timeout: 15000 });

  await new Promise((r) => setTimeout(r, 250));

  const frame = await page.$("#" + frameId);
  await frame.screenshot({ path: path.join(OUT, outFile) });
  console.log("wrote", outFile);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--force-device-scale-factor=1", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(PROMO, { waitUntil: "networkidle0" });
  await page.evaluate(() => window.__renderMath());
  await new Promise((r) => setTimeout(r, 400));

  await shootFrame(page, "hero", { heroState: "off" }, "1-before.png");
  await shootFrame(page, "hero", { heroState: "on" }, "2-after.png");
  await shootFrame(page, "langs", {}, "3-languages.png");

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

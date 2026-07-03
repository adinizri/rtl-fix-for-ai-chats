const puppeteer = require("puppeteer-core");
const path = require("path");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const POPUP = "file://" + path.join(__dirname, "..", "..", "popup.html");
const OUT = path.join(__dirname, "..", "screenshots", "popup-raw.png");
const FINAL = path.join(__dirname, "..", "screenshots", "4-popup.png");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 250, height: 210, deviceScaleFactor: 2 });
  await page.goto(POPUP, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: OUT });
  await browser.close();

  // Compose the popup screenshot onto a 1280x800 promo frame
  const { execFileSync } = require("child_process");
  const py = `
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 800
BG = (79, 70, 229)
canvas = Image.new("RGB", (W, H), (244, 244, 246))
d = ImageDraw.Draw(canvas)

# banner
d.rectangle([0, 0, W, 96], fill=BG)
f_title = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 30)
f_sub = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 16)
d.text((40, 24), "One-click toggle, no reload", font=f_title, fill=(255,255,255))
d.text((40, 62), "Turn the fix on or off instantly from the toolbar", font=f_sub, fill=(230,230,250))

popup = Image.open("${OUT}")
# downscale from 2x capture
popup = popup.resize((popup.width//2, popup.height//2), Image.LANCZOS)

# card behind popup to mimic a browser toolbar dropdown
card_pad = 20
card_x, card_y = 760, 160
card = Image.new("RGB", (popup.width + card_pad*2, popup.height + card_pad*2), (255,255,255))
card.paste(popup, (card_pad, card_pad))
canvas.paste(card, (card_x, card_y))

# simple drop shadow-ish border
d2 = ImageDraw.Draw(canvas)
d2.rectangle([card_x, card_y, card_x+card.width, card_y+card.height], outline=(224,224,230), width=2)

f_foot = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 14)
d2.text((W-260, H-38), "RTL Fix for AI Chats", font=f_foot, fill=(156,163,175))

canvas.save("${FINAL}")
print("wrote", "${FINAL}")
`;
  execFileSync("python3", ["-c", py]);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

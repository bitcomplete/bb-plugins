/** Run only inside validation/visual-ui.Dockerfile's offline scratch container. */
import { createServer } from "vite";
import { chromium } from "/opt/visual/node_modules/playwright-core/index.mjs";
const server = await createServer({configFile:false,root:process.cwd(),cacheDir:"/scratch/cache/vite",server:{host:"127.0.0.1",port:5173,strictPort:true},logLevel:"error"});
let browser;
const errors=[];
const captures=[];
try {
  await server.listen();
  browser=await chromium.launch({executablePath:"/usr/bin/chromium",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-zygote","--single-process"]});
  const page=await browser.newPage({deviceScaleFactor:1});
  try {
    page.setDefaultTimeout(15000);
    page.on("pageerror",error=>{errors.push(error.message);process.stderr.write(error.message+"\n");});
    for (const variant of [{name:"desktop-light",width:1440,height:1100,scheme:"light"},{name:"mobile-light",width:390,height:900,scheme:"light"},{name:"desktop-dark",width:1440,height:1100,scheme:"dark"}]) {
      await page.setViewportSize({width:variant.width,height:variant.height});
      await page.emulateMedia({colorScheme:variant.scheme});
      process.stderr.write(`Rendering ${variant.name}\n`);
      await page.goto("http://127.0.0.1:5173/test/ui/visual.html");
      await page.getByRole("button",{name:/Open problem.*Retries lose/}).click();
      await page.getByRole("heading",{name:"What happened"}).waitFor();
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
      if(overflow)errors.push(`${variant.name}: horizontal document overflow`);
      if(variant.width<760) {
        const layout=await page.locator(".si-workspace").evaluate(element=>getComputedStyle(element).gridTemplateColumns.split(" ").length);
        if(layout!==1)errors.push(`${variant.name}: ledger and details must stack in one column`);
        const detail=await page.locator(".si-detail").boundingBox();
        if(!detail||detail.width<variant.width*.85||detail.x<0||detail.x+detail.width>variant.width)errors.push(`${variant.name}: selected details are clipped or too narrow`);
      }
      captures.push({name:variant.name,png:(await page.screenshot({fullPage:false})).toString("base64")});
      if(variant.name==="desktop-light") {
        await page.getByRole("tab",{name:/Established/}).click();
        await page.getByRole("button",{name:/Open solution Retain/}).click();
        await page.getByRole("button",{name:"Re-test solution"}).click();
        await page.getByText("Re-test queued. Earlier results are preserved.").waitFor();
        captures.push({name:"retest-fixture",png:(await page.screenshot({fullPage:false})).toString("base64")});
        await page.getByRole("button",{name:"Export solution"}).click();
        const publication=page.getByRole("region",{name:"Publish export for review"});
        await publication.waitFor();
        await publication.scrollIntoViewIfNeeded();
        if(!await page.getByRole("button",{name:"Create draft PR"}).isDisabled())errors.push("publication must require explicit review before enabling");
        captures.push({name:"publication-fixture",png:(await page.screenshot({fullPage:false})).toString("base64")});
        await page.getByRole("tab",{name:"Performance"}).click();
        await page.getByRole("table").waitFor();
        captures.push({name:"performance-fixture",png:(await page.screenshot({fullPage:false})).toString("base64")});
      }
    }
    for(const diagram of [{name:"learning-loop",width:1200,height:590},{name:"evidence-ladder",width:1000,height:330}]){
      await page.setViewportSize({width:diagram.width,height:diagram.height});
      await page.goto(`http://127.0.0.1:5173/docs/images/${diagram.name}.svg`);
      const clipped=await page.locator("svg").evaluate(svg=>[...svg.querySelectorAll("text")].some(text=>{const box=text.getBBox();return box.x<0||box.y<0||box.x+box.width>svg.viewBox.baseVal.width||box.y+box.height>svg.viewBox.baseVal.height;}));
      if(clipped)errors.push(`${diagram.name}: diagram text extends outside its viewport`);
      if(diagram.name==="evidence-ladder") {
        const overflowingCard=await page.locator("svg").evaluate(svg=>[...svg.querySelectorAll("g > g")].some(group=>{const rect=group.querySelector("rect");if(!rect)return false;const card=rect.getBBox();return [...group.querySelectorAll("text")].some(text=>{const box=text.getBBox();return box.x<card.x||box.x+box.width>card.x+card.width;});}));
        if(overflowingCard)errors.push("evidence-ladder: card text overflows its boundary");
      }
      captures.push({name:diagram.name,png:(await page.screenshot({fullPage:false})).toString("base64")});
    }
  } finally { await page.close(); }
  if(errors.length)throw new Error(errors.join("\n"));
  process.stdout.write("VISUAL_CAPTURE_JSON="+JSON.stringify({fixture:true,captures,errors})+"\n");
} finally { if(browser)await browser.close(); await server.close(); }

import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { rcedit } from "rcedit";

const exePath = resolve("src-tauri/target/release/danmu-tools.exe");
const iconPath = resolve("src-tauri/icons/icon.ico");
const zhCnLangId = Buffer.from([0x04, 0x08, 0xb0, 0x04]);

const utf16le = (value) => Buffer.from(value, "utf16le");

async function patchVersionLanguage(path) {
  const data = await readFile(path);
  const neutralStringTable = utf16le("000004b0");
  const zhCnStringTable = utf16le("080404b0");
  let stringTableIndex = data.indexOf(zhCnStringTable);

  if (stringTableIndex === -1) {
    stringTableIndex = data.indexOf(neutralStringTable);
    if (stringTableIndex === -1) {
      throw new Error("Could not find Windows version string table language.");
    }
    zhCnStringTable.copy(data, stringTableIndex);
  }

  const translationName = utf16le("Translation");
  const translationIndex = data.indexOf(translationName, stringTableIndex);
  if (translationIndex === -1) {
    throw new Error("Could not find Windows version translation block.");
  }

  const neutralLangId = Buffer.from([0x00, 0x00, 0xb0, 0x04]);
  const searchEnd = Math.min(data.length, translationIndex + 128);
  const zhCnIndex = data.indexOf(zhCnLangId, translationIndex);
  if (zhCnIndex !== -1 && zhCnIndex < searchEnd) {
    await writeFile(path, data);
    return;
  }

  const neutralIndex = data.indexOf(neutralLangId, translationIndex);
  if (neutralIndex === -1 || neutralIndex >= searchEnd) {
    throw new Error("Could not find Windows version neutral language value.");
  }

  zhCnLangId.copy(data, neutralIndex);
  await writeFile(path, data);
}

await rcedit(exePath, {
  icon: iconPath,
  "file-version": "1.2.1",
  "product-version": "1.2.1",
  "version-string": {
    CompanyName: "小小鱼（QQ：521573）",
    FileDescription: "弹幕漏读工具",
    FileVersion: "1.2.1",
    ProductVersion: "1.2.1",
    ProductName: "DanmuTools",
    InternalName: "DanmuTools",
    InternalFilename: "DanmuTools",
    OriginalFilename: "DanmuTools.exe",
    LegalCopyright:
      "莫要用于任何商业或违法用途。否则造成的一切后果自负。与作者(鱼刺)和逆向思维工作室无关。",
    Author: "小小鱼"
  }
});

await patchVersionLanguage(exePath);

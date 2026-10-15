const sea = require("node:sea");
console.log("isSea:", sea.isSea());
const a = sea.getAsset("agent/lib.js");
console.log("asset found:", a !== null, a ? a.toString().trim() : "");
console.log("asset paths:", sea.getAssetNames ? sea.getAssetNames() : "no getAssetNames");

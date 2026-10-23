import { cnbNeutraliseHead } from "./src/cnb.ts";
const src = " ".repeat(100) + "FINGERPRINT".repeat(3) + "T".repeat(40) + "TAIL";
const out = cnbNeutraliseHead({ messages: [{ role: "system", content: src }] });
const s = String(out!.messages[0].content);
console.log("src len", src.length, "-> out len", s.length);
console.log("startsWith pads:", s.startsWith(" ".repeat(100)));
console.log("tail 20:", JSON.stringify(s.slice(-20)));

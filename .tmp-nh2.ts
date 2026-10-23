import { cnbNeutraliseHead } from "./src/cnb.ts";
const padded = cnbNeutraliseHead({
  messages: [{
    role: "system",
    content: " ".repeat(100) + "FINGERPRINT".repeat(3) + "TAIL",
  }],
});
const s = String(padded!.messages[0].content);
console.log(
  "len",
  s.length,
  "trimEnd:",
  JSON.stringify(s.trimEnd().slice(-20)),
);

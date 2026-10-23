import { cnbNeutraliseHead } from "./src/cnb.ts";
const padded = cnbNeutraliseHead({
  messages: [{
    role: "system",
    content: " ".repeat(100) +
      "FINGERPRINTFINGERPRINTFINGERPRINTFINGERPRINTTAIL",
  }],
});
console.log(JSON.stringify(String(padded!.messages[0].content)));

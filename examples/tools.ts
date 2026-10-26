// Call Wity's split and extract tools directly, as an agent would. Run: node --env-file=.env examples/tools.ts (after npm run build)
import { wity } from "wity-ai-provider";

const thread = `From: dana@example.com
The seal test on batch 2231 failed at 40 psi. Can we rerun it before Friday?

From: marcus@example.com
Yes. I booked the rig for Thursday 9 October at 10:00. It takes about 3 hours.
`;

const options = { toolCallId: "example", messages: [], context: {} };

const emails = (await wity.tools.split().execute?.({ text: thread, split: "one item per email" }, options)) ?? [];
for (const email of emails) {
  const fields = { sender: "The email address the email is from", asks: "What it asks for" };
  console.log(await wity.tools.extract().execute?.({ text: email, fields }, options));
}

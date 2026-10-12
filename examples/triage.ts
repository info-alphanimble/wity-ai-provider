// Route a support ticket with Wity. Run: node --env-file=.env examples/triage.ts (after npm run build)
import { experimental_decide } from "ai";
import { wity } from "wity-ai-provider";

const result = await experimental_decide({
  model: wity.decisionModel("wity-1"),
  state: "I was charged twice for my subscription this month. Please refund one of them today.",
  questions: {
    team: {
      type: "choice",
      instructions: "Which team should handle this ticket?",
      criteria: {
        billing: "Payments, charges and refunds",
        technical: "Bugs, errors and outages",
        other: "Anything else",
      },
    },
    urgent: {
      type: "boolean",
      instructions: "Does the customer ask for something to happen soon?",
    },
    severity: {
      type: "score",
      instructions: "How much is this hurting the customer?",
      criteria: ["Not at all", "A little", "A lot"],
    },
  },
});

console.log(result.answers.team.choice); // "billing"
console.log(result.answers.team.probabilities);
console.log(result.answers.urgent.probability);
console.log(result.answers.severity.score); // 0 to 2

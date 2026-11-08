// Configuration presence only. Never prints a credential or contacts a provider.
import { agentMailInboundStatus } from "../lib/integrations/agentmail";
import { emailStatus } from "../lib/integrations/email";
import { paymentStatus, publicBaseUrl } from "../lib/integrations/stripe";
console.log(JSON.stringify({
  publicUrl: publicBaseUrl(),
  operator: { ready: (process.env.GOOSE_OPERATOR_TOKEN?.length ?? 0) >= 24, missing: (process.env.GOOSE_OPERATOR_TOKEN?.length ?? 0) >= 24 ? [] : ["GOOSE_OPERATOR_TOKEN (at least 24 characters)"] },
  email: emailStatus(),
  payments: paymentStatus(),
  agentMailInbound: agentMailInboundStatus(),
  inboundGateway: { ready: !!process.env.GOOSE_INQUIRY_WEBHOOK_SECRET, missing: process.env.GOOSE_INQUIRY_WEBHOOK_SECRET ? [] : ["GOOSE_INQUIRY_WEBHOOK_SECRET"] },
  localTestWorkflow: { ready: true, externalEmails: false, moneyMoved: false },
  note: "Readiness means configuration is present, not that credentials were validated by a provider. Real transactional email is separately gated by the operator policy."
}, null, 2));

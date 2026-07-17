import helper from "../../../templates/proxy/helper.yml" with { type: "text" };
import processCheckin from "../../../templates/proxy/process-checkin.yml" with {
  type: "text",
};
import forwardReplies from "../../../templates/proxy/forward-replies.yml" with {
  type: "text",
};
import syncHelper from "../../../templates/proxy/sync-helper.yml" with {
  type: "text",
};

export const TEMPLATE_HELPER = helper;
export const TEMPLATE_PROCESS_CHECKIN = processCheckin;
export const TEMPLATE_FORWARD_REPLIES = forwardReplies;
export const TEMPLATE_SYNC_HELPER = syncHelper;

export const PROXY_WORKFLOW_TEMPLATES = Object.freeze([
  {
    repository: "decoy",
    filename: "helper.yml",
    content: TEMPLATE_HELPER,
  },
  {
    repository: "decoy",
    filename: "sync-helper.yml",
    content: TEMPLATE_SYNC_HELPER,
  },
  {
    repository: "control",
    filename: "process-checkin.yml",
    content: TEMPLATE_PROCESS_CHECKIN,
  },
  {
    repository: "control",
    filename: "forward-replies.yml",
    content: TEMPLATE_FORWARD_REPLIES,
  },
] as const);

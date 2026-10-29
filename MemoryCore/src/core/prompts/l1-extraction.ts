/**
 * L1 Extraction Prompt: scene segmentation + memory extraction
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are an expert in scene segmentation and memory extraction.
Your task is to analyze the user's conversation, detect scene changes, and extract structured core memories from it (only the three types persona, episodic and instruction).

**Output language**: write every free-text field (\`scene_name\` and memory \`content\`) in the same language as the user's messages. JSON field names, enum values and ISO timestamps stay in English.

### Task 1: Scene Segmentation
Analyze the [New messages to extract] together with the [Previous scene], then decide and output the scene of the current conversation.
- Inherit: if there is no clear change, keep the previous scene.
- Switch conditions: the user gives an explicit instruction (such as "change the topic"), the intent changes, or the user raises a new, independent goal.
- A conversation may have a single scene or several scenes (when the topic changes more than once).
- Naming rule: "I (the AI) am doing xxx (target activity) with xxx (user identity)" (**in the output language above**, about 30-50 characters or the equivalent length, one sentence, globally unique).

---

### Task 2: Core Memory Extraction
Using the background and the current scene, extract core information only from the [New messages to extract].

[General extraction principles]
1. Prefer omission to noise: filter out trivial chat, temporary instructions and one-off operations (such as "this time" or "this order"), and drop unreliable marginal information.
2. Independent and complete: a memory must still hold true outside the current conversation and be understandable without context. Its subject must be "the user (name)" or "the AI".
3. Merge related items: several messages that are strongly related or causally linked must be merged into one complete memory, not fragmented.

[The three supported types] (follow the type rules strictly)
> The "extraction patterns" and "trigger words" below are only an English skeleton for reference; **the actual \`content\` must be written in the output language above** (for example, for a Chinese-speaking user write it in Chinese; for an English-speaking user: "The user (Maya) is a senior product manager based in Berlin").

1. Personalized memory (type: "persona")
   - Definition: stable attributes, preferences, skills, values and habits of the user (such as residence, occupation, dietary restrictions).
   - Extraction pattern: "The user ([name]) likes / is / is good at ..."
   - Scoring (priority): 80-100 (health / taboos / core traits); 50-70 (general preferences / skills); <50 (vague or minor, may be dropped).
   - Trigger words: like, usually, often, "I am the kind of person who ...".

2. Objective event memory (type: "episodic")
   - Definition: objective actions, decisions, plans or outcomes that happened. Never include purely subjective feelings.
   - Extraction pattern: "The user ([name]) at [preferably an exact absolute time] in [place] [did something (may include cause, process, result)]".
   - Time constraint: derive the absolute time from the message timestamp where possible. If it can be determined, output activity_start_time and activity_end_time (ISO 8601) in metadata. Omit them when they cannot be determined.
   - Scoring (priority): 80-100 (important events / plans); 60-70 (ordinary complete activities); <60 (trivial matters, drop directly).

3. Global instruction memory (type: "instruction")
   - Definition: long-term behavior rules, format preferences and tone controls that the user gives to the AI.
   - Extraction pattern: "The user requires / wants the AI to ... from now on when answering"
   - Trigger words: from now on, always, remember, must.
   - Scoring (priority): -1 (an extremely strict global hard rule); 90-100 (core behavior rules); 70-80 (important requests); <70 (temporary requests, drop directly).

---

### What must NOT be extracted
- Trivial chat and greetings; temporary, purely instrumental requests (such as "translate this for me this time")
- One-off operation instructions (anything related to "this time" or "this order")
- Repeated content; the AI assistant's own behavior or output
- Information that does not belong to the 3 types above
- Purely subjective feelings (emotional expressions with no objective event)

---

### Task 3: Output Format (JSON)
Return one valid JSON array and nothing else. Each item of the array is a scene, containing the message range of that scene and the memories extracted from it:

[
  {
    "scene_name": "the scene name, newly generated or inherited",
    "message_ids": ["list of message IDs that belong to this scene"],
    "memories": [
      {
        "content": "a complete, independent memory statement (following the pattern of its type)",
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

About the metadata field:
- episodic type: if the activity time can be determined, fill in {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- other types, or when the time cannot be determined: output an empty object {}

If the whole conversation has no meaningful memory, still output the scene segmentation, with memories as an empty array:
[
  {
    "scene_name": "scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly in the JSON array format above. Do not output any extra Markdown code fence markers (such as \`\`\`json) or explanatory text.`;

export type MemoryPromptMode = "chat" | "code";

export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `You are an expert in work scene segmentation and team-shared memory extraction.
Your task is to analyze multi-person work messages, detect work scene changes, and extract structured work memories that can be shared within the project team.

This task targets team collaboration in a work setting. Focus on project facts, task progress, decisions and conclusions, working methods, SOPs, taboos, design ideas, deliverables and similar information that has long-term value for the team's later collaboration and for Agent execution.

**Output language**: write every free-text field (\`scene_name\` and memory \`content\`) in the dominant language of the messages to extract. JSON field names, enum values and ISO timestamps stay in English.

---

### Task 1: Work Scene Segmentation

Analyze the [New messages to extract] together with the [Previous scene] and the [Background messages], and decide which work scene the current messages belong to.

[Scene definition]
A scene is a group of messages about the same project, task, module, requirement, problem, decision, incident, customer scenario or work goal.

[Inherit condition]
If the new messages still continue the previous project, task, requirement, problem or work goal, keep the previous scene.

[Switch condition]
Switch to, or create, a new scene when any of the following happens:
1. The subject of discussion becomes another project, module, requirement, customer, issue, PR, experiment, incident or deliverable.
2. The work goal clearly changes, for example from "requirement discussion" to "release scheduling".
3. A new, independent task, decision thread or troubleshooting thread clearly appears.
4. Several work topics appear one after another in the same batch of messages; split them into several scenes.

[Naming rule]
- The scene name must be named after the work object.
- Recommended format: "The team is [advancing the target activity] around [project / module / topic]".
- About 30-50 characters or the equivalent length, one sentence, globally unique.
- Examples:
  - "The team is designing shared-memory rules around group-chat extraction for Agent Memory"
  - "The team is troubleshooting a production timeout around the Billing API"
  - "The team is confirming the query-interface requirements around the Andon pilot"

---

### Task 2: Team-Shared Work Memory Extraction

Using the background and the current scene, extract shareable core work information only from the [New messages to extract].

[General extraction principles]

1. Oriented to work collaboration:
   - Extracted memories should help team members or Agents understand the project background, continue tasks, reuse experience or avoid repeating mistakes in later work.
   - Do not extract ordinary greetings, small talk, temporary emotional expressions or one-off tool requests.

2. Oriented to team sharing:
   - Extracted content is shared within the project team by default.
   - Extract only work content that is suitable for the team to share.
   - Do not extract personal preferences, private life or sensitive information unrelated to work.

3. Independent and complete:
   - Every memory must be understandable outside the current conversation.
   - content must contain a clear subject, work object, conclusion, status or method.
   - Do not use context-dependent expressions such as "this", "that" or "as mentioned above".

4. Accurate attribution:
   - A suggestion, concern or judgment from one person is not a team decision.
   - Write something as a firm conclusion only when there is explicit confirmation, a final call, adoption or an execution plan.
   - Express unconfirmed content as "the team is discussing ...", "a proposal is still to be confirmed ..." or "there is a risk that ...".

5. Merge related items:
   - Merge strongly related messages into one complete memory.
   - Do not split one work conclusion into several fragments.
   - But extract different work objects, different tasks and different methodologies separately.

6. Extract only from new messages:
   - The [Background messages] are used only to understand context, references and time.
   - Never add new memories extracted from the background messages.
   - source_message_ids must contain only message ids from the [New messages to extract].

7. Handling AI / Agent output:
   - Do not automatically treat an AI suggestion as a team fact or team decision.
   - Extract it only when a human member adopts or confirms it, or when the Agent output is itself a clear tool execution result, deliverable or experiment result.
   - An AI-generated draft, proposal or analysis that is explicitly used as a later work asset may be extracted as work_artifact or work_method.

---

### The four supported types of work memory

The memory \`type\` must be chosen from the following enum:

1. Work fact (type: "work_fact")

Definition:
Factual information about projects, systems, business, customers, requirements, decisions, status, risks, constraints and experiment results.

Suitable for extraction:
- Project goals
- Product requirements
- Technical solutions
- Architecture constraints
- Customer feedback
- Decision conclusions
- Current status
- Risks and blockers
- Experiment results
- Term definitions
- System facts

Examples:
- "The team edition of Agent Memory uses a four-layer structure: L0 Work Event, L1 Work Record, L2 Project Scene Block and L3 Team Operating Memory."
- "The team decided that team-shared memory extracts only work content and does not build personal profiles."
- "The Andon pilot requires the memory query interface to support filtering by project and to allow configuring the returned fields."
- "Work discussion and small talk are mixed in multi-person group chats, so there is a risk of wrongly extracting unrelated content."

priority:
- 90-100: key decisions, core requirements, long-term constraints, important risks.
- 70-89: ordinary facts of lasting value to the current project.
- <70: fine-grained, temporary or low-impact facts, drop directly.

---

2. Work task (type: "work_task")

Definition:
Tasks, action items and responsibilities that need later execution, follow-up, confirmation or delivery.

Suitable for extraction:
- To-do items
- Tasks with a clear owner
- Tasks with a clear deadline
- Problems that need follow-up
- Blocked items
- Next-step plans
- Task status changes

Examples:
- "The backend team needs to finish the table design for the many-to-many trace between record and event by Friday."
- "The product side needs to add a description of the permission boundaries of team-shared memory."
- "The L1 prompt has entered the work-memory type convergence stage; the next step is to update the downstream enum."

priority:
- 90-100: tasks that block delivery, have a clear deadline or affect the critical path.
- 70-89: ordinary tasks with a clear owner or a clear follow-up action.
- <70: vague, temporary to-dos with no clear follow-up action, drop directly.

Suggested metadata:
- If the owner can be determined, fill in {"owner": "name or ID"}.
- If the deadline can be determined, fill in {"deadline": "ISO8601"}.
- If the status can be determined, fill in {"status": "todo|doing|done|blocked|deferred|cancelled"}.

---

3. Work method (type: "work_method")

Definition:
Reusable methods, SOPs, processes, principles, taboos, design ideas, lessons learned, judgment criteria and Agent behavior rules that the team has formed at work.

This is one of the most important types of long-term team work memory. It records not only what happened, but also what to do, what not to do and which principles to judge by when a similar task comes up later.

Suitable for extraction:
- SOPs
- Collaboration processes
- Design principles
- Reasoning behind technical route choices
- Evaluation criteria
- Risk-avoidance rules
- Taboos and boundaries
- Reusable experience
- Agent execution strategies
- Prompt writing principles
- Project methodology

Examples:
- "L1 extraction for team-edition Agent Memory should prefer a small number of high-level work types, to avoid types so fine-grained that later aggregation becomes difficult."
- "Extraction of team-shared memory should give priority to project facts, tasks, methods and deliverables, not ordinary chat content."
- "When multi-person messages contain only one person's suggestion and no explicit confirmation, it must not be extracted directly as a team decision."
- "The L1 prompt should keep the output JSON structure stable, and adapt to new scenarios mainly by adjusting the type enum and the extraction rules."
- "Work-method memories can capture SOPs, taboos, design ideas and reusable experience to support later Agent execution."

priority:
- 90-100: core methods that are long-term stable, reusable across tasks and affect Agent behavior or team processes.
- 70-89: methods with clear reuse value for the follow-up work of the current project.
- <70: methods that are too temporary, vague or only apply to a one-off operation, drop directly.

Suggested metadata:
- If the scope can be determined, fill in {"scope": "project|team|module|agent|workflow"}.
- If the method category can be determined, fill in {"method_type": "sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion"}.
- For a taboo or anti-pattern, fill in {"method_type": "anti_pattern"}.

---

4. Work artifact (type: "work_artifact")

Definition:
Work assets that the team produces, references, maintains or needs later, including documents, PRs, issues, design drafts, experiment reports, code repositories, data tables, meeting minutes, prompts and proposal drafts.

Suitable for extraction:
- Documents
- PRs / issues
- Code branches
- Experiment reports
- Design drafts
- Meeting minutes
- Prompts
- Spreadsheets
- Links
- Proposal drafts
- Work output generated by an Agent and adopted

Examples:
- "The L1 work-memory extraction prompt is a core prompt asset in the design of team-edition Agent Memory."
- "The team uses the four-layer work-memory structure as the design basis for the later L2 and L3 aggregation prompts."
- "The results of the Flowchart vs StateDiagram comparison experiment can serve as the basis for choosing a short-term memory compression scheme."

priority:
- 90-100: core documents, key PRs, release-related assets, important experiment reports.
- 70-89: ordinary work assets that may be reused later.
- <70: temporary files, low-value links, drafts that were not adopted, drop directly.

Suggested metadata:
- If the asset type can be determined, fill in {"artifact_type": "doc|pr|issue|repo|branch|design|report|prompt|dataset|meeting_note"}.
- If the link or identifier can be determined, fill in {"artifact_ref": "link, ID or name"}.

---

### What must NOT be extracted

The following should usually not be extracted:
- Greetings, pleasantries, jokes, and small talk with no work value.
- Temporary one-off requests, such as "fix the formatting for me this time".
- AI suggestions or temporary drafts that were not adopted.
- Details with no clear follow-up value.
- Personal preferences, private life or sensitive information unrelated to the team's work.

---

### Task 3: Output Format (JSON)

Return one valid JSON array and nothing else. Each item of the array is a work scene, containing the message range of that scene and the work memories extracted from it:

[
  {
    "scene_name": "the work scene name, newly generated or inherited",
    "message_ids": ["list of message IDs that belong to this scene"],
    "memories": [
      {
        "content": "a complete, independent work memory statement suitable for team sharing",
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["message_id_1", "message_id_2"],
        "metadata": {}
      }
    ]
  }
]

About the metadata field:
- Every type may output an empty object {}.
- work_task may add owner, deadline, status.
- work_method may add scope, method_type.
- work_artifact may add artifact_type, artifact_ref.
- work_fact may add work_object, status, activity_start_time, activity_end_time.
- metadata must not contain unrelated personal information.

If the new messages contain no meaningful team-shared work memory, still output the scene segmentation, with memories as an empty array:

[
  {
    "scene_name": "work scene name",
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Output strictly in the JSON array format above. Do not output any extra Markdown code fence markers (such as \`\`\`json) or explanatory text.`;

export function getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "None" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "None";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `**Output language**: write \`scene_name\` and memory \`content\` in the dominant language of the user's messages in the "New messages to extract" below.

[Previous scene]: ${previousSceneName}

[Background conversation] (only to understand context and infer relations and time; never extract memories from it):
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[New messages to extract] (use the timestamps to work out times, and extract memories only from here!):
${newText}`;
}

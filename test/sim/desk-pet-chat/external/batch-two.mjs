/** Pure task adapters for BEAM and LHTB 2.0 public task metadata. */

const BEAM_URL = "https://github.com/mohammadtavakoli78/BEAM";
const LHTB_URL = "https://github.com/zli12321/LHTB";
const BEAM_ABILITIES = {
  abstention: "abstention",
  contradiction_resolution: "contradiction-resolution",
  event_ordering: "event-ordering",
  information_extraction: "information-extraction",
  instruction_following: "instruction-following",
  knowledge_update: "knowledge-update",
  multi_session_reasoning: "multi-session-reasoning",
  preference_following: "preference-following",
  summarization: "summarization",
  temporal_reasoning: "temporal-reasoning",
};
const BEAM_LOCAL_TYPES = {
  abstention: "adversarial",
  contradiction_resolution: "correction",
  event_ordering: "temporal",
  information_extraction: "fact",
  instruction_following: "multi-turn",
  knowledge_update: "correction",
  multi_session_reasoning: "multi-hop",
  preference_following: "preference",
  summarization: "long-context",
  temporal_reasoning: "temporal",
};

function requiredString(value, label, id) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${id ?? "record"}: ${label} must be a non-empty string`);
  return value.trim();
}

function difficulty(value) {
  if (Number.isInteger(value) && value >= 1 && value <= 5) return value;
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "easy") return 2;
  if (normalized === "medium") return 3;
  if (normalized === "hard" || normalized === "clear") return 4;
  return 3;
}

function normalizeHistory(source, id) {
  const messages = [];
  const append = (message) => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new TypeError(`${id}: every history message must preserve a user/assistant role and string content`);
    }
    messages.push({ role: message.role, content: message.content });
  };
  const numericOrdinal = (value) => {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    return null;
  };
  const planRows = Array.isArray(source) ? source : null;
  const planGroups = [];
  if (planRows?.length && planRows.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) {
    planRows.forEach((entry, sourceIndex) => {
      for (const [key, batches] of Object.entries(entry)) {
        const match = /^plan-(\d+)$/.exec(key);
        if (!match || batches === undefined || batches === null) continue;
        if (!Array.isArray(batches)) throw new TypeError(`${id}: ${key} must contain an array of source batches`);
        planGroups.push({ planNumber: BigInt(match[1]), sourceIndex, batches });
      }
    });
  }
  if (planGroups.length) {
    planGroups.sort((left, right) => left.planNumber < right.planNumber ? -1 : left.planNumber > right.planNumber ? 1 : left.sourceIndex - right.sourceIndex);
    for (const plan of planGroups) {
      const indexedBatches = plan.batches.map((batch, sourceIndex) => ({ batch, sourceIndex, ordinal: numericOrdinal(batch?.batch_number) }));
      if (indexedBatches.every((entry) => entry.ordinal !== null)) {
        indexedBatches.sort((left, right) => left.ordinal < right.ordinal ? -1 : left.ordinal > right.ordinal ? 1 : left.sourceIndex - right.sourceIndex);
      }
      for (const { batch } of indexedBatches) {
        if (!Array.isArray(batch?.turns)) throw new TypeError(`${id}: ${`plan-${plan.planNumber}`} batch must contain a turns array`);
        for (const turn of batch.turns) {
          if (Array.isArray(turn)) for (const message of turn) append(message);
          else append(turn);
        }
      }
    }
    if (messages.length === 0) throw new TypeError(`${id}: chat history must not be empty`);
    return messages;
  }
  const batches = Array.isArray(source) ? source : source?.turns;
  if (!Array.isArray(batches)) throw new TypeError(`${id}: chat history must be an array or contain a turns array`);
  for (const batch of batches) {
    const turns = Array.isArray(batch) ? batch : batch?.turns;
    if (!Array.isArray(turns)) throw new TypeError(`${id}: each chat batch must contain a turns array`);
    for (const turn of turns) {
      if (Array.isArray(turn)) for (const message of turn) append(message);
      else append(turn);
    }
  }
  if (messages.length === 0) throw new TypeError(`${id}: chat history must not be empty`);
  return messages;
}

function probeAnswer(probe) {
  for (const key of ["ideal_answer", "answer", "ideal_response", "ideal_summary", "expected_compliance"]) {
    if (typeof probe[key] === "string" && probe[key].trim()) return probe[key];
  }
  return "";
}

/**
 * Convert official BEAM conversation + probing-question records to the shared external-task schema.
 * Input records may be {id/chatId, chat, probingQuestions}; probe category and all upstream fields
 * are retained. Each output task has the full, role-preserving fixed conversation and one probe.
 */
export function normalizeBeam(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("beam: records must be an array");
  const revision = requiredString(options.revision, "revision", "beam");
  const split = options.split ?? "100K";
  const result = [];
  for (const record of records) {
    const chatId = requiredString(String(record?.chatId ?? record?.id ?? record?.chat_id ?? ""), "chat id", "beam");
    const history = normalizeHistory(record.chat ?? record.history ?? record, chatId);
    const groups = record.probingQuestions ?? record.probing_questions ?? record.questions;
    if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw new TypeError(`${chatId}: probingQuestions must be an ability-keyed object`);
    for (const [ability, probes] of Object.entries(groups)) {
      if (!Array.isArray(probes)) throw new TypeError(`${chatId}: probes for ${ability} must be an array`);
      const category = BEAM_ABILITIES[ability] ?? ability.replaceAll("_", "-").toLowerCase();
      probes.forEach((probe, index) => {
        const question = requiredString(probe?.question, "question", chatId);
        const questionId = String(probe?.question_id ?? probe?.id ?? `${chatId}-${ability}-${index + 1}`);
        const reference = probeAnswer(probe);
        const rubric = Array.isArray(probe?.rubric) ? probe.rubric.filter((item) => typeof item === "string" && item.trim()) : [];
        const criteria = [...rubric];
        if (!criteria.length && typeof probe?.tests_for === "string") criteria.push(probe.tests_for);
        result.push({
          schemaVersion: 1,
          dataset: "beam",
          id: questionId,
          revision,
          split,
          mode: "fixed-history",
          title: `BEAM ${split} ${category}`,
          categories: ["chat", "memory", "context"],
          questionTypes: [BEAM_LOCAL_TYPES[ability] ?? "fact"],
          difficulty: difficulty(probe?.difficulty),
          history,
          turns: [{ id: `${questionId}-probe`, prompt: question }],
          oracle: { referenceAnswers: reference ? [reference] : [], criteria, raw: { ability, upstreamQuestionTypes: Object.fromEntries(["question_type", "abstention_type", "contradiction_type", "ordering_type", "temporal_type", "instruction_type", "preference_type", "update_type", "summarization_type"].flatMap((key) => typeof probe[key] === "string" ? [[key, probe[key]]] : [])), probe } },
          assets: [],
          environment: { required: false },
          readiness: { runnable: Boolean(reference || criteria.length), blockers: reference || criteria.length ? [] : ["BEAM probe has no reference answer or rubric criteria"] },
          adaptationNotes: [
            "The complete BEAM chat history is retained with its original user/assistant roles; assistant messages are never relabeled as user data.",
            "This is a fixed-history replay of one probe; it does not reproduce BEAM batch ingestion, online memory updates, or official benchmark execution.",
            "BEAM probes with explicit expected-compliance or abstention rubrics are retained as oracle criteria without converting the historical assistant output into a user turn.",
            "The local schema questionType is a coarse registered mapping; the original ability and subtype remain attached in oracle.raw.",
            ...(split === "128K" ? ["The pinned public repository labels its smallest available directory 100K; this adapter uses the paper's approximately 128K bucket name and records the source's file split in the manifest."] : []),
          ],
          source: { url: options.sourceUrl ?? BEAM_URL, datasetUrl: options.datasetUrl ?? "https://huggingface.co/datasets/Mohammadta/BEAM", revision, license: "CC-BY-SA-4.0", split, upstreamSplit: record.upstreamSplit ?? split, conversationId: chatId, questionId, ability },
        });
      });
    }
  }
  return result;
}

function parseTomlScalar(toml, key, section) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scoped = section
    ? toml.match(new RegExp(`(?:^|\\n)\\s*\\[${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\[|$)`))?.[1] ?? ""
    : toml;
  const match = scoped.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, "m"));
  if (!match) return undefined;
  const value = match[1].replace(/\s+#.*$/, "").trim();
  if (/^(true|false)$/.test(value)) return value === "true";
  if (/^\d+$/.test(value)) return Number(value);
  return value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
}

function parseTomlStringArray(toml, key, section) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scoped = section
    ? toml.match(new RegExp(`(?:^|\\n)\\s*\\[${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\[|$)`))?.[1] ?? ""
    : toml.split(/\n\s*\[/, 1)[0];
  const match = scoped.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`, "m"));
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Normalize public LHTB 2.0 task directories as environment tasks. Readiness requires both a
 * discovered hidden verifier and the official patched harness; public prompt metadata alone is not
 * evidence that a task can be scored.
 */
export function normalizeLhtb(records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError("lhtb: records must be an array");
  const revision = requiredString(options.revision, "revision", "lhtb");
  const split = options.split ?? "2.0";
  return records.map((record) => {
    const id = requiredString(record?.taskId ?? record?.task_id ?? record?.id, "task id", "lhtb");
    const instruction = requiredString(record?.instruction, "instruction.md", id);
    const toml = requiredString(record?.taskToml ?? record?.task_toml, "task.toml", id);
    const category = record.category ?? "unknown";
    const taskName = parseTomlScalar(toml, "name", "task") ?? id;
    const dockerImage = parseTomlScalar(toml, "docker_image", "environment");
    const network = parseTomlScalar(toml, "network", "environment");
    const timeoutSec = parseTomlScalar(toml, "timeout_sec", "agent");
    const verifierTimeoutSec = parseTomlScalar(toml, "timeout_sec", "verifier");
    const verifierAvailable = record.hiddenVerifierAvailable === true;
    const harnessAvailable = record.officialHarnessAvailable === true;
    const blockers = [];
    if (!verifierAvailable) blockers.push("Official hidden verifier is not present in the authorized local task bundle");
    if (!harnessAvailable) blockers.push("Modified official Harbor harness is not available; stock Harbor does not reproduce LHTB continue-until-timeout behavior");
    return {
      schemaVersion: 1,
      dataset: "lhtb",
      id,
      revision,
      split,
      mode: "environment",
      title: taskName,
      categories: ["tools", "context"],
      questionTypes: ["execution"],
      difficulty: difficulty(record.difficulty),
      history: [],
      turns: [{ id: `${id}-instruction`, prompt: instruction }],
      oracle: { referenceAnswers: [], criteria: [], raw: { upstreamCategory: category, taskToml: toml, hiddenVerifierAvailable: verifierAvailable, verifierPaths: record.verifierPaths ?? [], solutionAvailable: record.solutionAvailable === true, officialHarnessAvailable: harnessAvailable } },
      assets: (record.assets ?? []).map((asset) => typeof asset === "string" ? { path: asset } : asset),
      environment: {
        required: true,
        kind: "harbor-terminal-bench",
        artifacts: parseTomlStringArray(toml, "artifacts"),
        dockerImage,
        allowInternet: network === true,
        agentTimeoutSec: timeoutSec,
        verifierTimeoutSec,
        cpuCount: parseTomlScalar(toml, "cpus", "environment"),
        memoryMb: parseTomlScalar(toml, "memory_mb", "environment"),
        storageMb: parseTomlScalar(toml, "storage_mb", "environment"),
        continueUntilTimeout: parseTomlScalar(toml, "continue_until_timeout", "agent"),
        rawTaskToml: toml,
      },
      readiness: { runnable: verifierAvailable && harnessAvailable, blockers },
      adaptationNotes: [
        "LHTB is a stateful terminal environment benchmark; the prompt is retained for reference and is not converted into a static chat case.",
        "Public task.toml, instruction, environment and asset paths do not include the hidden verifier or oracle solution; official score requires the authorized verifier and modified Harbor harness.",
        "Preserves the upstream timeout, Docker image, resources, network setting and continue-until-timeout flag; adapter metadata is not an official score.",
      ],
      source: { url: LHTB_URL, datasetUrl: "https://huggingface.co/datasets/IntelligenceLab/Long-Horizon-Terminal-Bench", revision, license: "Apache-2.0", split, taskSplit: record.upstreamSplit ?? split, taskId: id, taskName },
    };
  });
}

export const BATCH_TWO_UPSTREAM = Object.freeze({ BEAM_URL, LHTB_URL });

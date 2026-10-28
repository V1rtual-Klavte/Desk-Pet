/** Pure adapters for the first approved external-evaluation batch. */

const GAIA_URL = "https://huggingface.co/datasets/gaia-benchmark/GAIA";
const MULTICHALLENGE_URL = "https://huggingface.co/datasets/ScaleAI/MultiChallenge";
const MEMORYARENA_URL = "https://huggingface.co/datasets/ZexueHe/memoryarena";

function requireRecords(records, options, dataset) {
  if (!Array.isArray(records)) throw new TypeError(`${dataset}: records must be an array`);
  if (!options || typeof options.revision !== "string" || !options.revision.trim()) {
    throw new TypeError(`${dataset}: revision is required to pin upstream provenance`);
  }
  return { revision: options.revision.trim(), split: options.split ?? "validation" };
}

function nonEmptyString(value, field, id) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${id}: ${field} must be a non-empty string`);
  }
  return value;
}

function source(url, revision, license, extra = {}) {
  return { url, revision, license, ...extra };
}

function taskBase({ dataset, id, revision, split, mode, title, categories, questionTypes, difficulty, history, turns, oracle, assets, environment, readiness, adaptationNotes, source: sourceInfo }) {
  return {
    schemaVersion: 1,
    dataset,
    id,
    revision,
    split,
    mode,
    title,
    categories,
    questionTypes,
    difficulty,
    history,
    turns,
    oracle,
    assets,
    environment,
    readiness,
    adaptationNotes,
    source: sourceInfo,
  };
}

/**
 * Normalize authorized local GAIA dev/validation records. This adapter never fetches data,
 * accesses Hugging Face credentials, or relaxes the upstream gated-dataset conditions.
 */
export function normalizeGaia(records, options) {
  const { revision, split } = requireRecords(records, options, "gaia");
  if (!/^(dev|validation)$/i.test(split)) {
    throw new TypeError("gaia: only an authorized local dev/validation split is supported");
  }
  return records.map((row) => {
    const id = nonEmptyString(row?.task_id, "task_id", "gaia");
    const question = nonEmptyString(row?.Question, "Question", id);
    const level = Number(row?.Level);
    if (![1, 2, 3].includes(level)) throw new TypeError(`${id}: Level must be 1, 2, or 3`);
    const reference = row["Final answer"];
    if (typeof reference !== "string" || !reference.trim()) throw new TypeError(`${id}: Final answer is required`);
    const filePath = typeof row.file_path === "string" && row.file_path ? row.file_path : undefined;
    const fileName = typeof row.file_name === "string" && row.file_name ? row.file_name : undefined;
    const hasAsset = Boolean(filePath || fileName);
    const asset = hasAsset ? [{ path: filePath ?? fileName, fileName, upstreamPath: filePath }] : [];
    return taskBase({
      dataset: "gaia", id, revision, split, mode: "task", title: `GAIA ${id}`,
      categories: ["chat", "tools"], questionTypes: ["execution"],
      difficulty: level + 2, history: [], turns: [{ id: `${id}-question`, prompt: question }],
      oracle: { referenceAnswers: [reference], criteria: [], raw: { annotatorMetadata: row["Annotator Metadata"], record: row } },
      assets: asset,
      environment: { required: false },
      readiness: { runnable: !hasAsset, blockers: hasAsset ? ["GAIA attachment must be supplied in the authorized local input bundle and resolved by the importer"] : [] },
      adaptationNotes: [
        "Consumes caller-supplied authorized local records only; no network download or HF credential access.",
        "GAIA Level 1–3 is mapped monotonically to local difficulty 3–5; this is an adapter convention, not upstream difficulty equivalence.",
        ...(hasAsset ? ["Attachment reference is preserved; unresolved attachments block execution and are never silently dropped."] : ["Text-only question is exposed as one user turn; tool availability and official GAIA scoring are not reproduced by this adapter."]),
      ],
      source: source(GAIA_URL, revision, "Gated upstream dataset terms; caller must already have authorized local access", { configuration: "2023_all", split, taskId: id }),
    });
  });
}

/** Normalize official ScaleAI MultiChallenge rows with their full fixed conversation context. */
export function normalizeMultiChallenge(records, options) {
  const { revision, split } = requireRecords(records, options, "multichallenge");
  return records.map((row) => {
    const id = nonEmptyString(row?.question_id, "question_id", "multichallenge");
    const evaluationQuestion = nonEmptyString(row?.target_question, "target_question", id);
    // HF's Arrow/Parquet rows expose the struct-of-lists as { role: [], content: [] };
    // accept the semantically equivalent list-of-structs representation used by exports.
    const conversation = Array.isArray(row.conversation)
      ? row.conversation
      : Array.isArray(row.conversation?.role) && Array.isArray(row.conversation?.content) && row.conversation.role.length === row.conversation.content.length
        ? row.conversation.role.map((role, index) => ({ role, content: row.conversation.content[index] }))
        : null;
    if (!conversation || conversation.length === 0) throw new TypeError(`${id}: conversation must be a non-empty aligned turn list`);
    const conversationHistory = conversation.map((turn, index) => {
      if (!turn || !["user", "assistant"].includes(turn.role) || typeof turn.content !== "string") {
        throw new TypeError(`${id}: conversation[${index}] must have user/assistant role and string content`);
      }
      return { role: turn.role, content: turn.content };
    });
    if (conversationHistory.at(-1)?.role !== "user") throw new TypeError(`${id}: fixed conversation must end with a user turn`);
    const latestUserTurn = conversationHistory.pop();
    if (!latestUserTurn?.content.trim()) throw new TypeError(`${id}: final conversation user turn must contain the live prompt`);
    const axis = nonEmptyString(row.axis, "axis", id);
    const expectedJudgeResult = nonEmptyString(row.pass_criteria, "pass_criteria", id);
    const axisQuestionType = {
      INFERENCE_MEMORY: "multi-hop",
      INSTRUCTION_RETENTION: "multi-turn",
      SELF_COHERENCE: "multi-turn",
      RELIABLE_VERSION_EDITING: "correction",
    }[axis];
    if (!axisQuestionType) throw new TypeError(`${id}: unsupported MultiChallenge axis ${axis}`);
    return taskBase({
      dataset: "multichallenge", id, revision, split, mode: "fixed-history", title: `MultiChallenge ${axis}`,
      categories: ["chat", "context"], questionTypes: [axisQuestionType], difficulty: 3,
      history: conversationHistory, turns: [{ id: `${id}-target`, prompt: latestUserTurn.content }],
      oracle: {
        referenceAnswers: [],
        criteria: [`Official judge question: ${evaluationQuestion}`, `Expected judge result: ${expectedJudgeResult}`],
        raw: { targetQuestion: evaluationQuestion, passCriteria: row.pass_criteria, numTurns: row.num_turns, record: row },
      },
      assets: [], environment: { required: false }, readiness: { runnable: true, blockers: [] },
      adaptationNotes: [
        "All upstream conversation turns except the final user request are replayed as fixed user/assistant history; prior assistant messages are fixture context, never newly generated evaluation output.",
        "The final user turn from conversation is the live driver prompt. target_question is the upstream judge's question about the response, not a prompt for the tested assistant; pass_criteria remains oracle-only.",
        "The source exposes pass_criteria rather than a machine-readable rubric; judge calibration remains an integration responsibility.",
      ],
      source: source(MULTICHALLENGE_URL, revision, "CC-BY-4.0", { split, questionId: id, axis }),
    });
  });
}

/** Normalize only MemoryArena's group_travel_planner configuration; preserve interdependence. */
export function normalizeMemoryArenaTravel(records, options) {
  const { revision, split } = requireRecords(records, options, "memoryarena");
  return records.map((row) => {
    if (!Number.isInteger(row?.id)) throw new TypeError("memoryarena: id must be an integer");
    const id = String(row.id);
    const person = row.base_person;
    if (!person || typeof person !== "object") throw new TypeError(`${id}: base_person is required`);
    const baseQuery = nonEmptyString(person.query, "base_person.query", id);
    if (!Array.isArray(person.daily_plans)) throw new TypeError(`${id}: base_person.daily_plans must be an array`);
    if (!Array.isArray(row.questions) || row.questions.length === 0) throw new TypeError(`${id}: questions must be a non-empty array`);
    if (!Array.isArray(row.answers) || row.answers.length !== row.questions.length) throw new TypeError(`${id}: answers must align with questions`);
    const questions = row.questions.map((q, index) => nonEmptyString(q, `questions[${index}]`, id));
    const subtaskDependencies = questions.map((_, index) => ({
      index,
      dependsOn: ["base_person"],
      previousSubtasksAvailable: index,
    }));
    return taskBase({
      dataset: "memoryarena", id, revision, split, mode: "environment", title: `MemoryArena Group Travel ${id}`,
      categories: ["memory", "plan", "tools"], questionTypes: ["execution", "cross-session"], difficulty: 5,
      history: [], turns: questions.map((prompt, index) => ({ id: `subtask-${index + 1}`, prompt })),
      oracle: { referenceAnswers: [], criteria: [], raw: { answers: row.answers, record: row } },
      assets: [],
      environment: {
        required: true,
        kind: "memoryarena-group-travel-planner",
        contract: "Memory-Agent-Environment multi-session loop with persistent shared trip state and sequentially dependent subtasks",
        basePerson: person,
        baseQuery,
        dailyPlans: person.daily_plans,
        dependencies: subtaskDependencies,
        raw: row,
      },
      readiness: { runnable: false, blockers: ["MemoryArena-compatible travel-planning environment, persistent cross-session state, and official task evaluator are not provided by this adapter"] },
      adaptationNotes: [
        "Only group_travel_planner rows are accepted; other MemoryArena configurations require their own adapter.",
        "Questions remain an ordered task sequence and answers remain oracle-side; they are not flattened into independent prompts. The adapter preserves ordering and prior context availability without inventing mandatory dependency edges.",
        "base_person, daily plans, full upstream row, and dependency order are preserved as environment contract metadata.",
        "Current readiness is metadata-only until a compatible environment and evaluator are integrated.",
      ],
      source: source(MEMORYARENA_URL, revision, "CC-BY-4.0", { configuration: "group_travel_planner", split, recordId: row.id }),
    });
  });
}


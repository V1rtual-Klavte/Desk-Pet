#!/usr/bin/env python3
"""Run the revision-locked Snap LoCoMo QA evaluator on exported hypotheses."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = ROOT / "upstream-lock.json"
REVISION = "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_jsonl(path):
    rows = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise ValueError(f"hypotheses line {line_number} is invalid JSON: {error}") from error
    if not rows:
        raise ValueError("hypotheses file is empty")
    return rows


def locked_file(data_dir, lock, name):
    entry = lock["downloads"][name]
    path = data_dir / entry["path"]
    raw = path.read_bytes()
    if sha256(raw) != entry["sha256"]:
        raise ValueError(f"locked input hash mismatch: {entry['path']}")
    return path, raw, entry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hypotheses", required=True, type=Path)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if lock.get("downloads", {}).get("locomo10", {}).get("revision") != REVISION:
        raise ValueError("upstream lock revision does not match the official LoCoMo runner")
    reference_path, _, reference_entry = locked_file(args.data_dir, lock, "locomo_evaluation")
    raw_path, raw_bytes, _ = locked_file(args.data_dir, lock, "locomo10")
    if reference_entry.get("revision") != REVISION:
        raise ValueError("official evaluation script revision mismatch")

    samples = json.loads(raw_bytes.decode("utf-8"))
    sample_by_id = {}
    for sample in samples:
        sample_id = sample.get("sample_id")
        if not isinstance(sample_id, str) or sample_id in sample_by_id:
            raise ValueError("locked LoCoMo data has a missing or duplicate sample_id")
        sample_by_id[sample_id] = sample

    hypotheses = read_jsonl(args.hypotheses)
    seen = set()
    official_rows = []
    for row in hypotheses:
        case_id = row.get("case_id")
        question_id = row.get("question_id")
        sample_id = row.get("sample_id")
        question_index = row.get("question_index")
        category = row.get("category")
        hypothesis = row.get("hypothesis")
        if not isinstance(case_id, str) or case_id in seen or question_id != case_id:
            raise ValueError("hypothesis has missing/duplicate case_id or mismatched question_id")
        seen.add(case_id)
        if not isinstance(sample_id, str) or not isinstance(question_index, int) or isinstance(question_index, bool):
            raise ValueError(f"{case_id}: invalid LoCoMo source identity")
        match = re.fullmatch(r"locomo-(.+)-q(\d{4})", case_id)
        if not match or match.group(1) != sample_id or int(match.group(2)) != question_index:
            raise ValueError(f"{case_id}: case_id does not encode sample/question identity")
        if not isinstance(hypothesis, str) or row.get("hypothesis_sha256") != sha256(hypothesis.encode("utf-8")):
            raise ValueError(f"{case_id}: hypothesis hash mismatch")
        if row.get("case_id_sha256") != sha256(case_id.encode("utf-8")):
            raise ValueError(f"{case_id}: case identity hash mismatch")
        source_report_hash = row.get("source_report_sha256")
        if not isinstance(source_report_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", source_report_hash):
            raise ValueError(f"{case_id}: source report hash missing")
        sample = sample_by_id.get(sample_id)
        qa_rows = sample.get("qa") if sample else None
        if not isinstance(qa_rows, list) or question_index >= len(qa_rows):
            raise ValueError(f"{case_id}: no matching question in locked LoCoMo data")
        qa = qa_rows[question_index]
        question = qa.get("question")
        if (row.get("question") != question or category != qa.get("category")
                or row.get("question_sha256") != sha256(str(question).encode("utf-8"))):
            raise ValueError(f"{case_id}: exported question/category differs from locked LoCoMo data")
        answer = qa.get("answer", qa.get("adversarial_answer"))
        if answer is None:
            raise ValueError(f"{case_id}: locked LoCoMo question has no answer")
        official_rows.append({"category": int(category), "answer": str(answer),
                              "prediction": hypothesis, "evidence": qa.get("evidence", [])})

    spec = importlib.util.spec_from_file_location("locked_locomo_evaluation", reference_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load locked LoCoMo evaluation.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scores, _, _ = module.eval_question_answering(official_rows, eval_key="prediction")
    if len(scores) != len(hypotheses):
        raise RuntimeError("official evaluator returned an unexpected score count")

    output = []
    for row, score in zip(hypotheses, scores):
        if not isinstance(score, (int, float)) or not 0 <= score <= 1:
            raise RuntimeError(f"{row['case_id']}: official score outside [0,1]")
        output.append({**row, "official_score": float(score),
                       "official_metric": "locomo-category-score",
                       "official_revision": REVISION,
                       "official_script_sha256": lock["downloads"]["locomo_evaluation"]["sha256"],
                       "official_data_sha256": lock["downloads"]["locomo10"]["sha256"]})
    payload = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in output)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("x", encoding="utf-8", newline="\n") as file:
        file.write(payload)
    print(f"[memory-bench] official LoCoMo evaluation: {len(output)} rows -> {args.out}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # CLI boundary: nonzero exit preserves failure.
        print(f"[memory-bench] LoCoMo official runner failed: {error}", file=sys.stderr)
        sys.exit(1)

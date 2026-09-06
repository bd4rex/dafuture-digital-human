[中文](README.md)

# Bundled Future Teacher Project Knowledge

This library ships with the digital-human project and is automatically linked on first startup. The workbench lists topic files for preview, download, append, replacement, and deletion. Instructions in notices, meeting remarks, and operational suggestions remain reference material, not server or model system instructions.

## Knowledge Organization

The 27 source documents (10 PDFs and 17 DOCX files) describe one project and are organized into **one library, seven topic files, and 89 Q&A cards**. Each card includes common question variants, facts suitable for composing an answer, and source page or paragraph references.

| Topic | Cards | Main questions |
| --- | ---: | --- |
| Project and policy | 14 | Organizers, duration, responsibilities, pilots, funding |
| Training and participation | 16 | Cohorts, dates, hotels, quotas, registration, costs |
| Laboratory and expert guidance | 16 | Standards, courses, lesson cases, expert assignments |
| Nanjing pilot | 11 | Experience center, schools, scenarios, workshops, budget |
| Haidian pilot | 10 | Courses, lesson cases, training, schools, reported results |
| Changsha pilot | 12 | Accounts, scenarios, agents, training, budget discrepancies |
| Historical milestones and statistics | 10 | Meetings, superseded plans, population and account definitions |

Prepared on **September 6, 2026**; developments outside the supplied materials have not been verified. Training dates, locations, and registration requirements follow the stamped August 24, 2026 notice. Earlier Xuzhou plans, the third-draft expert list, draft competency standards, and statistics from different dates retain their status; plans are not treated as completed events.

## Published Files

- `future-teacher-2026/*.md`: the seven topic files automatically imported.
- `future-teacher-2026/manifest.json`: library ID, version, filenames, and SHA-256 checksums. Only explicitly listed files are imported.
- `future-teacher-2026/sources.json`: source IDs, original filenames, hashes, dates, regions, and version notes for all 27 inputs. It resolves S01–S27 references in the cards.
- `../test/fixtures/future-teacher-regression.jsonl`: 58 regression questions and required context evidence.

Complete originals, intermediate OCR images, individual full transcripts, and processing artifacts remain in the local delivery package and are not committed with the application. The source catalog provides audit references; inspecting the underlying text still requires the originals. Topic data remains in its original Chinese, with bilingual operating documentation.

## Automatic Linking and Persistence

Local `npm start` and repository-root `docker compose up -d --build` enable bundled knowledge by default. Docker keeps sources at `/app/bundled-knowledge` and runtime data at `/data/knowledge.json` and `/data/knowledge-files/`; an empty writable data-directory mount cannot hide the image's sources. If legacy `content.json` is absent, an empty backup is created. Legacy content does not enter answers.

First linking appends and deduplicates content without replacing existing documents. The `appliedBundles` receipt and document index are saved in one atomic write; subsequent starts do not re-import the same library. Workbench deletion, replacement, and complete clearing remain effective after restarts and image updates. Existing model settings, administration passwords, scripts, and logs stay in their original data directory.

For a generic empty library, set `BUNDLED_KNOWLEDGE_ENABLED=false` before first startup. This only disables automatic linking; it does not delete imported documents. To restore a deleted topic, upload its Markdown file from this directory in the workbench. Administrators should review and apply later material revisions there; repository updates do not overwrite administered knowledge.

Compose automatically creates and mounts a persistent named volume. A host bind-mounted directory must be writable by the container's `node` user (UID 1000). A new image can append the library while reusing an existing `docker run` named volume. Do not use `docker compose down -v` for data you need to retain.

## Retrieval and Answer Verification

The seven topic files occupy about 51.4 KiB and produce 14 chunks with the current importer. Their total context is approximately 22,524 characters, within the 24,000-character budget. Every question receives evidence across all topics, reducing omissions across regions, historical/current dates, and question variants. This is an implementation choice for this small dataset, not a claim of optimality at every library size.

`npm test` covers automatic linking, legacy index compatibility, deduplication, restarts, persisted deletion/replacement, corrupted-file checks, and a real HTTP answer path. Of the 58 material regressions, 50 check factual evidence and eight check evidence of unpublished information, conflicting reports, or insufficient material. HTTP tests use mock model responses; they do not measure real-model accuracy, refusal quality, or latency.

The existing grounded answer mode is recommended. Project facts should retain their source dates; dates, counts, funding figures, and lists should not be conflated. Visitor-facing answers remain conversational without proactively displaying filenames or source IDs. Adding substantial material can activate ranked retrieval and requires another coverage review.

## Prerequisites

Knowledge is included and needs no separate upload. A data volume with complete model connection settings can continue answering; a fresh deployment still requires an API endpoint, API key, model name, and a successful connection test in the workbench. The repository contains no real model credentials, and startup does not automatically send billable model requests.

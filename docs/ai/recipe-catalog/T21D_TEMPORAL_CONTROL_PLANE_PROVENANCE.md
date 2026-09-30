# T21D production D1 temporal and control-plane provenance

Status: metadata evidence unavailable locally; metadata-only PR awaits independent review. Main is frozen at `df857a8ea25fe81f3bc220bb9cfee50c1d41aac3`. No production SQL, workflow dispatch, mutation, migration, restore, or deploy was performed.

## Evidence boundary

The last known hydrated production receipt is `2026-09-25T20:14:41Z` (Deploy `36183890785`); the first confirmed missing-order receipt is `2026-09-29T13:07:52Z` (diagnostic `36572487026`). Protected diagnostic `36706489599` later reported 500 recipes, 6,720 ingredient rows, zero order rows and 0/500 hydrated, with ledger tip 0038. These observations do not identify a writer or a specific transition time.

The unverified external enrichment lead is around `2026-09-26T13:05:00Z` (22:05 JST). The verified ZIP's local mtime is `2026-09-26T13:09:24Z`; its ctime is `2026-09-26T14:01:12Z`. The ZIP central-directory member timestamps span 22:08:42-22:08:44 JST, and the extracted README member mtime is 22:08:42 JST. These are artifact construction/copy times, not execution evidence. The README claims a production write but gives no target DB, SQL command, actor, or receipt.

## Timeline

| UTC | Source | Event | Bookmark | Actor/run | Interpretation |
| --- | --- | --- | --- | --- | --- |
| 2026-09-25 20:14:41 | protected Deploy receipt | 500 hydrated | unavailable | `36183890785` | Last known good |
| 2026-09-26 13:02:02 | GitHub Actions | Deploy workflow started; production job skipped | unavailable | `36243811596`, `tako-vn` | Staging-only run near external lead |
| ~2026-09-26 13:05 | historical handoff lead | Reported external enrichment operation | unavailable | unverified | Candidate pivot only |
| 2026-09-26 13:08:42-13:08:44 | ZIP member metadata | Archive members timestamped | unavailable | local artifact | Construction evidence only |
| 2026-09-26 13:09:24 | local ZIP stat | ZIP mtime | unavailable | local artifact | Not execution proof |
| 2026-09-26 15:14:24 | GitHub PR | PR #11 opened | unavailable | PR #11 | Canonical source entered review after ZIP timestamp |
| 2026-09-26 20:21:48 | GitHub PR | PR #11 merged | unavailable | `8687ff9f3e8f` | No authorized production content mutation |
| 2026-09-26 21:05:31 | GitHub PR | PR #12 opened | unavailable | PR #12 | Provisional runtime projection entered review |
| 2026-09-26 21:23:09 | GitHub PR | PR #12 merged | unavailable | `c6ea259904a8` | No authorized production content mutation |
| 2026-09-29 13:07:52 | protected diagnostic | 0/500 hydrated, missing ingredient positions | unavailable | `36572487026` | First confirmed bad |
| 2026-09-30 11:10 | protected diagnostic | 500/6720/0 order rows; V1 and V2 authority rejected | unavailable | `36706489599` | Latest catalog baseline |

## GitHub Actions correlation

The Deploy workflow versions at all 16 distinct head SHAs in the window were inspected from those commits, not inferred from the current workflow. They contain a production Environment job for Worker release with read-only D1 checks; none contains a D1 catalog mutation command. All 25 Deploy runs in the window skipped their production job, including the run near 13:05 UTC. The Production D1 Migration workflow has zero runs in the window. The Production Read-Only Certification run `36563767379` failed before runtime catalog proof. The first bad Production D1 Read-Only Diagnostics run `36572487026` succeeded. This excludes these inspected GitHub Actions jobs as the observed production catalog writer, but not manual/external writes or configuration operations.

| UTC | Deploy run | Head SHA | Actor | Trigger | Conclusion | `production` Environment job |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-26T05:39:40Z | `36221454575` | `bf57451e4a1a047eeff7a0938b903d1a37b6f8c9` | `vn-taphoanhatung` | `workflow_run` | `skipped` | skipped |
| 2026-09-26T11:03:24Z | `36237637195` | `662a06554dae8b88becf6e023b2e3f328f00fd89` | `tako-vn` | `workflow_run` | `success` | skipped |
| 2026-09-26T12:05:35Z | `36240842196` | `cb22cfb5f83c3ef03103bf8f628e0f234fec56c9` | `tako-vn` | `workflow_run` | `success` | skipped |
| 2026-09-26T13:02:02Z | `36243811596` | `c81d6da2b3a9c051270b97953bfbb2c5aa34d057` | `tako-vn` | `workflow_run` | `success` | skipped |
| 2026-09-26T20:28:09Z | `36269628127` | `8687ff9f3e8f6b6cbf466ee61968bb5f3469498c` | `tako-vn` | `workflow_run` | `success` | skipped |
| 2026-09-26T21:28:09Z | `36273034453` | `c6ea259904a8fa79213cd6e659f57dcd97145bb8` | `tako-vn2` | `workflow_run` | `success` | skipped |
| 2026-09-26T22:02:18Z | `36274945067` | `8147dde64306651e03d8e2bd3424a9ab2dc61125` | `vn-taphoanhatung` | `workflow_run` | `success` | skipped |
| 2026-09-27T01:19:22Z | `36285175574` | `0b2e0a17578bdc744427944b90db5b76bdbfe33c` | `takovn1` | `workflow_run` | `failure` | skipped |
| 2026-09-27T03:51:27Z | `36292621523` | `dff7446855964d9fc60008c370ef656371652a13` | `takovn1` | `workflow_run` | `success` | skipped |
| 2026-09-27T03:57:45Z | `36292920780` | `dff7446855964d9fc60008c370ef656371652a13` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-27T08:03:54Z | `36305024017` | `b44e9355ce8988e7acb7c3b12c55bc2b27340e1a` | `vn-tako4` | `workflow_dispatch` | `success` | skipped |
| 2026-09-27T08:33:09Z | `36306554840` | `9d64178b8bbc8f07672a1e9f0434867f3699f339` | `vn-tako4` | `workflow_dispatch` | `success` | skipped |
| 2026-09-27T09:15:20Z | `36308782040` | `e35df74b7a10ee6de1677bf8e059c7ef82ad55fc` | `vn-tako4` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T01:12:58Z | `36365130166` | `85660fa497f3da7110a07ec2189309fbef81d701` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T02:46:43Z | `36371122773` | `85660fa497f3da7110a07ec2189309fbef81d701` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T03:06:14Z | `36372371894` | `85660fa497f3da7110a07ec2189309fbef81d701` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T06:08:51Z | `36385014725` | `85660fa497f3da7110a07ec2189309fbef81d701` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T13:57:42Z | `36432382384` | `12348efd015ae72337fbeb08651150a7d28ee638` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T19:50:30Z | `36475014158` | `12348efd015ae72337fbeb08651150a7d28ee638` | `tako-vn1` | `workflow_dispatch` | `failure` | skipped |
| 2026-09-28T20:13:41Z | `36477693577` | `94056d29ed00a1000e65eb8e1348384638bc02af` | `vn-tako4` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T20:38:06Z | `36480590869` | `94056d29ed00a1000e65eb8e1348384638bc02af` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T20:44:08Z | `36481287388` | `94056d29ed00a1000e65eb8e1348384638bc02af` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T20:53:54Z | `36482417097` | `94056d29ed00a1000e65eb8e1348384638bc02af` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T22:48:06Z | `36494497735` | `8072e0fea9f8f3588426969007dda06cadbbfbb7` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |
| 2026-09-28T22:59:50Z | `36495580095` | `8072e0fea9f8f3588426969007dda06cadbbfbb7` | `tako-vn1` | `workflow_dispatch` | `success` | skipped |

## Cloudflare control plane

Local Cloudflare credentials were absent. A metadata GET through Wrangler returned `CLOUDFLARE_API_TOKEN` required, so database creation time/version, bookmark values, and account Audit Logs remain unavailable. Consequently, no restore or config operation has been ruled out. Cloudflare bookmarks are database-wide: even a transition near 13:05 UTC would be temporal correlation only. Audit Logs are not per-query SQL history, and no D1 SQL endpoint is part of the proposed workflow.

The new workflow requires exact-main CI and the protected `production` Environment. Its script permits only GET database metadata, GET Time Travel bookmarks, and GET account Audit Logs; it uploads only bookmark values, counts and sanitized D1 event fields. The script checks the database UUID/name before bookmark collection and omits audit actor email/IP and raw metadata. Audit Logs require Account Settings Read, which may be absent from the existing protected token; unavailable audit data is reported as unavailable, never as proof that no restore occurred. The workflow has not been merged or dispatched.

`writerProven=false`, `writerOutputProven=false`, `sourceArtifactProven=false`, `executionProven=false`, `ingestionPipelineProven=false`, `ROOT_CAUSE_STATUS=UNRESOLVED`. Production repair, release, 0039 and position repair remain stopped.

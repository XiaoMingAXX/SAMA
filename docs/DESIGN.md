# Design record

## Discover: understand the care situation

The project begins with orchid-care situations, rather than assuming that more sensors alone solve a problem. Project notes describe coarse charcoal-based substrates, differences between growing locations, and displays where regular specialist care may be limited. These are starting points for further observation and interviews.

The working care loop is **notice → verify → interpret → prioritise → act → verify again**. A live reading supports only part of that loop. Without a plant identity, sampling context, care history and follow-up observation, it is difficult to understand what a reading means.

Public evidence is deliberately limited: raw interviews, participant contact information, audio links and course materials are not redistributed here. Earlier presentation drafts contained rehearsal survey/interview counts and illustrative quotes. They are not treated as validated research results and are not used to substantiate demand or impact.

## Define: make observations traceable

Working HMW: **How might we help orchid growers identify which plant or growing zone needs attention, and decide what to check next using traceable observations?**

Design requirements derived for this iteration:

- Separate a physical sensor from the plant it currently measures.
- Preserve ownership and binding history when a sensor moves.
- Let users choose which observations become a long-term record.
- Combine numbers with plant profiles, photographs and care events.
- Support review and export so observations remain useful beyond the dashboard.
- Carry units, source labels, time ranges and limitations into later analysis.

These are product requirements, not evidence that the resulting product improves growth.

## Develop: use prototypes to expose missing information

The LAN prototype established a working communication and display path. The cloud demonstration removed the need for a continuously running local computer but still treated the probe as the centre of the record. The warehouse iteration introduces plant identity, account separation, sensor reuse and selected retention.

Using fewer than ten gateways/sensors with roughly 500 plant profiles is a planning target. It motivates a single modest collector, SQLite and private object storage instead of a distributed analytics platform. It is not a completed capacity benchmark.

The current implementation is an observation warehouse. It does not measure every plant continuously when probes are rotated; a missing observation is a gap, not evidence of stable conditions.

## Deliver: evaluate the decision, not just the interface

Next validation should examine whether users can identify which plant was measured, record context, find prior observations, understand uncertainty and choose an appropriate next check. Probe calibration and representative sampling in orchid substrates need a separate physical protocol. A suggested sample-preparation approach in project notes is not yet a validated measurement method.

Future language-model work should be evaluated against traceable inputs and expert-reviewed advice. Begin with read-only explanations and explicit uncertainty, then collect user feedback on usefulness. Automated irrigation, dosing and diagnosis are outside the current prototype.

Commercial adoption, willingness to pay and improved plant outcomes remain hypotheses. No numeric market or outcome claim is made in this repository.

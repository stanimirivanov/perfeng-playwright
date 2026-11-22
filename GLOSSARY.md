# Browser runner language

Terms for native browser measurement and diagnostics. Shared terms are defined in the [Perfeng glossary](https://github.com/stanimirivanov/perfeng-contracts/blob/main/GLOSSARY.md).

## Language

**Browser Journey**
A complete business interaction sequence executed as one iteration.

**Semantic Measurement**
A duration between the defined start and completion of an interaction, measured on the browser clock.

**Cold Profile**
A repetition profile that creates a fresh browser context and page for each iteration.

**Warm Profile**
A repetition profile that reuses a browser context under a declared page lifetime.

**Browser Diagnostic Mode**
The diagnostic configuration for a run, such as baseline, lightweight, trace, memory or smoothness.

**Browser Baseline Mode**
The browser diagnostic configuration without additional collectors. Use **Baseline Version** for an approved comparison reference.

**Browser Environment**
Observed host, browser and rendering characteristics and calibration for browser measurement.

**Browser Comparison Cohort**
Measurements grouped by reviewed comparable browser and host settings, including page lifetime and diagnostic mode. Cohort eligibility belongs to the reviewed qualification and selection boundary.

**Local Artifact Receipt**
Evidence of an exact locally committed browser artifact.

**Native Worker Spool**
Dedicated retained local evidence for a Native Worker Attempt, including uncertain or interrupted work.

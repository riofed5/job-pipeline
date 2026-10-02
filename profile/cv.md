<!--
CV v4 (2026-10-02): v3R plus the changes Nhan approved after debate 27 (research/targeting-debate.md) and the
webshop counts read from the 25 May 2026 production dump. Built from build/content_v4.js:
CV_CONTENT=./content_v4 node build_html.js A ... (see build/README.md). One page in A and B, verified in the PDFs.
Headings marked A: (no client names) / B: (Faba, Kielo Toimitilat named).
-->

**Nhan Nguyen**
Helsinki, Finland · +358 465701272 · ntnhan240696@gmail.com · linkedin.com/in/nhannguyen24 · github.com/riofed5

**PROFILE**

Full-stack developer with 4+ years of experience in TypeScript, React, Next.js and Node.js. Sole developer on a business-to-business (B2B) webshop since Aug 2026, handling features, deployment and production support. Main developer on a Finnish/English commercial real-estate website for 20 months. Also builds personal LLM tools using Claude Code, Codex and Gemini.

**SKILLS**

**Core:** TypeScript, JavaScript, React, Next.js (Pages/App Router), Tailwind CSS, Chakra UI
**Backend:** Node.js, REST APIs, Prisma, PostgreSQL, MariaDB, Redis, BullMQ, headless WordPress, PHP
**CI/CD and servers:** GitHub Actions CI, shell deployment scripts, Docker, Linux (nginx/pm2)
**Hosting and quality:** DigitalOcean, Vercel, Sentry, Jest, Playwright
**AI-assisted development:** Claude Code, GitHub Copilot, Gemini

**EXPERIENCE**

**Tecci Oy, Helsinki · Software Developer** · Mar 2023 – present
Contributed to websites and apps for six Finnish clients, mostly Next.js with headless WordPress.

A: Cattle-breeding cooperative's B2B webshop
B: Faba, cattle-breeding cooperative's B2B webshop · Jul 2024 – present
- **Sole webshop developer since Aug 2026**: features, deployment and production support for a shop with ~15,000 orders a year and ~3,200 products.
- Fixed a Yarn 4 deployment flag that had left staging serving a stale build for a day. Added pre-deploy backups and deployment/rollback documentation.
- Implemented **the agreed redesign alone**: 10 desktop and 5 mobile page layouts. Restructured WordPress fields using Advanced Custom Fields (ACF). Live May 2026.
- Built role-based continuous-order and offer reports for marketing and finance staff, with XLSX exports. Added gift-card exports through a new WordPress REST endpoint in 2026.
- Implemented contract-level customer pricing, with contract levels and roles carried in auth, municipality delivery zones A–E with zone search, and refactored VIP-restricted product access.
- Built the first working version of the shop's material bank (embedded file and folder manager): Prisma data model, folder and file APIs, DigitalOcean Spaces storage, folder-tree UI and search by keywords.

A: Commercial real-estate website (~165 listings in Sep 2026)
B: Kielo Toimitilat, commercial real-estate website (~165 listings in Sep 2026) · Oct 2023 – May 2025
- Built Next.js pages and WordPress ACF content structures over 20 months. Added Finnish/English localisation with next-i18next and SEO fixes. Client staff use the site daily.
- Wrote Next.js API routes for premises listings from the tiloja.fi listing service in Nov 2024. Updated the integration after the service changed its ad format in May 2025.

A = B: Logistics survey tool (~20 projects live at the time) · Mar – Oct 2023; maintenance 2024
- Main frontend developer in 2023 on a team replacing an Excel survey workflow. Added branching questions and follow-ups, and fixed user-reported bugs.
- Built backend sync for offline PWA memos and notes, an attachments API and CSV/XLSX exports.

**Unfair Advantage, Helsinki · Full-stack Developer** · Oct 2022 – Mar 2023
- Built recurring events in an unreleased Meteor app, Dockerised it and set up DigitalOcean deployments.

**MyXline, Helsinki · Software Developer** · Jan 2022 – Apr 2022
- Shipped single-use SMS review links using JWT and Firebase Cloud Functions (Google Cloud) in a React Native delivery app with ~100 users.

**EDUCATION**

B.Eng. Information Technology, Metropolia University of Applied Sciences, Espoo · Aug 2018 – Jun 2022

**LANGUAGES**

English (fluent) · Vietnamese (native)

---

## Change log: what changed from v3R, and the incident behind each change

Incident, 2026-10-02: Nhan's job-pipeline marked six applications rejected (Alibaba Cloud graduate programme, Netlight graduate consultant, Supermetrics Agentic AI Engineer, Reaktor AI Developer, Hoxhunt Security, Reaktor Software developer). A Claude Fable 5.1 session inside the pipeline project reviewed the CV that had been sent (v2.3, hand-edited on 21 Sep to add "Kotlin, Java (university projects)" and "NestJS (learning)") and wrote the feedback that debate 27 examined (Fable 5.1 vs GPT-6-Astra, three rounds, NO CONFLICTS; `research/targeting-debate.md`). Nhan then approved the four changes below on 2026-10-02.

1. **Profile, sentences 2–3.** "Has handled deployment and production support for a business-to-business (B2B) webshop since Aug 2026. Turns requests from non-technical client staff into working features." → "Sole developer on a business-to-business (B2B) webshop since Aug 2026, handling features, deployment and production support. Main developer on a Finnish/English commercial real-estate website for 20 months."
   Incident: the feedback said the profile proved only one thing and that the "requests" sentence was generic agency language. Debate 27 agreed to add the second verified proof (Kielo, 20 months) and to keep the date on the ownership claim, which the feedback had dropped.
2. **Profile, sentence 4.** "Also builds personal LLM tools using the Claude Code and Codex command-line interfaces." → "Also builds personal LLM tools using Claude Code, Codex and Gemini."
   Incident: Nhan's edit of 2026-10-02 (adds Gemini; debate 27 had proposed replacing this sentence with a Projects entry, which Nhan declined).
3. **Webshop scale.** Heading "(client turnover ~55 M€)" removed; first bullet now ends "for a shop with ~15,000 orders a year and ~3,200 products."
   Incident: the feedback's one correct, unanswered point: "55 M€ is the client's number, not a property of the system you built." Both debaters agreed the page lacked webshop operating scale and that only Nhan's data could supply it. Counts read from the 25 May 2026 production dump: 15,354 orders May 2025 – Apr 2026 (14,860 completed; 15,383 in calendar 2025), 3,263 products (2,787 visible in the shop). The two numbers were first tried in the heading; they wrapped in both naming versions, so they moved into the bullet as the approved fallback.
4. **Kielo heading.** "(premises in 34 municipalities)" → "(~165 listings in Sep 2026)".
   Incident: the feedback asked for listing counts; the number was already in the facts file. GPT required the date so the count reads as the site's inventory, not as growth attributed to Nhan after the May 2025 handover.
5. **Certification section removed** ("AWS Certified Cloud Practitioner (2021, expired 2024)").
   Incident: the feedback called it a negative signal; GPT argued that an expired entry-level certificate proves no AWS experience and that softening the wording ("2021–2024") would only hide the expiry. Nhan reversed his 2026-09-15 decision to list it. The renderers now skip the section when `certification` is null.

Not changed, on purpose: the employer title "Software Developer" (title on paper; a reference check would show it), the AI-assisted skills row (ads ask for it; it costs one line), the material-bank bullet, the two early jobs (there is no six-month gap: five months between jobs, three after graduation in June 2022), and no Projects section (Nhan's call). "Kotlin, Java (university projects)" and "NestJS (learning)" were never in the build and stay out.

Numbers available but not on the page (interview material): 1,764 distinct customers ordered in the 12 months to Apr 2026 (2,755 since Jan 2023); 3,695 accounts (3,377 Mtech customer logins, 318 WordPress accounts); 49,267 orders since Jan 2023; 679 offers. The shop went live in Jan 2023 and Tim built most of it; the counts describe the system Nhan now maintains alone, not results he produced.

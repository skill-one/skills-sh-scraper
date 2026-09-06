## Description:

Deep Skill Finder helps agents search Meyo community skills, rank up to five task-matched recommendations, and install the selected skill into the local agent skills directory.

This skill is ready for commercial/non-commercial use.

## Publisher:

[lintong123](https://clawhub.ai/user/lintong123)

### License/Terms of Use:

MIT-0

## Use Case:

Developers and agent users use this skill when they need to discover an existing skill for a task, compare recommended Meyo community options, and install the selected skill for immediate use.

### Deployment Geography for Use:

Global

## Known Risks and Mitigations:

Risk: Search requests can disclose task descriptions to a remote recommendation service.

Mitigation: Avoid sensitive, proprietary, or regulated details in search queries.

Risk: Installing a recommended remote skill changes the local agent skills directory.

Mitigation: Install only after an intentional user selection, then inspect and scan the recommended skill before enabling it for real tasks.

Risk: The security summary flags weak package and path safeguards around remote installation.

Mitigation: Use a trusted target skills directory and review installed files before running the new skill.

## Reference(s):

- [ClawHub release page](https://clawhub.ai/lintong123/skills/deep-skill-finder)
- [Meyo skill discovery](https://www.meyo.life/skill)
- [Meyo community](https://www.meyo.life/community/home)
- [Meyo community skills](https://www.meyo.life/community/square/skills)

## Skill Output:

**Output Type(s):** [text, markdown, shell commands, configuration, guidance]

**Output Format:** [Markdown tables and prose with shell command examples.]

**Output Parameters:** [1D]

**Other Properties Related to Output:** [Returns up to five ranked skill recommendations and uses the selected skill name for installation.]

## Skill Version(s):

1.2.9 (source: evidence release metadata and SKILL.md frontmatter)

## Ethical Considerations:

Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment.

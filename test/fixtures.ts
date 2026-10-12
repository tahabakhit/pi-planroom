export const simplePlan = `# Checked result\n\n## Goal\nCreate a checked result.\n\n## Approach\nCreate a small fixture file.\n\n## Implementation\n- Create result.txt.\n\n## Verification\n- \`node -e 'process.exit(0)'\` reports success.\n`;

export const markdown = `# Add recovery\n\n## Goal\nRecover unfinished work.\n\n## Approach\nUse existing storage.\n\n## Implementation\n- Add the recovery reader.\n- Exercise restart behavior.\n\n## Verification\n- \`npm test\` — all tests pass.\n- Restart retains the active item.\n\n## Assumptions\nNo deployment.\n`;

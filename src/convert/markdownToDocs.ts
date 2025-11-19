export function convertToGoogleDocs(markdown: string): any[] {
    const requests: any[] = [];
    let index = 1; // Google Docs starts at index 1

    // Normalize newlines to avoid index drift on Windows (CRLF -> LF)
    const normalizedMarkdown = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Split by lines
    const lines = normalizedMarkdown.split('\n');

    // We will process line by line.
    // Note: This is a simplified converter. It handles headers, lists, and plain text.
    // It inserts text in reverse order (or we track index).
    // Actually, inserting at the end is easier if we calculate index, but inserting at index 1 repeatedly reverses content.
    // So we should append to the end.
    // But we need to know the end index.
    // Strategy: Insert text at the current 'index', then increment 'index' by length + 1 (for newline).

    for (const line of lines) {
        let content = line;
        let type = 'NORMAL_TEXT';
        let headingLevel = 0;
        let isList = false;

        // Detect Headers
        if (line.startsWith('# ')) { headingLevel = 1; content = line.substring(2); }
        else if (line.startsWith('## ')) { headingLevel = 2; content = line.substring(3); }
        else if (line.startsWith('### ')) { headingLevel = 3; content = line.substring(4); }
        else if (line.startsWith('#### ')) { headingLevel = 4; content = line.substring(5); }
        else if (line.startsWith('##### ')) { headingLevel = 5; content = line.substring(6); }
        else if (line.startsWith('###### ')) { headingLevel = 6; content = line.substring(7); }

        // Detect Lists
        else if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
            isList = true;
            content = line.trim().substring(2);
        }

        // Clean content (remove bold/italic markers for now, or implement rich text parsing later)
        // For now, just insert the raw text or stripped text.
        // Let's strip basic markdown syntax for cleaner docs if possible, or just keep it.
        // The user wants "conversion", so ideally we strip it.
        // Simple strip:
        content = content.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');

        if (content.length > 0) {
            requests.push({
                insertText: {
                    text: content + '\n',
                    location: {
                        index: index,
                    },
                },
            });

            // Apply styling
            const endIndex = index + content.length + 1;

            if (headingLevel > 0) {
                requests.push({
                    updateParagraphStyle: {
                        range: {
                            startIndex: index,
                            endIndex: endIndex,
                        },
                        paragraphStyle: {
                            namedStyleType: `HEADING_${headingLevel}`,
                        },
                        fields: 'namedStyleType',
                    },
                });
            }

            if (isList) {
                requests.push({
                    createParagraphBullets: {
                        range: {
                            startIndex: index,
                            endIndex: endIndex,
                        },
                        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
                    },
                });
            }

            index = endIndex;
        } else {
            // Empty line
            requests.push({
                insertText: {
                    text: '\n',
                    location: {
                        index: index,
                    },
                },
            });
            index += 1;
        }
    }

    return requests;
}

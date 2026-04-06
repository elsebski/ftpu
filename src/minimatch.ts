/**
 * Simple glob matcher — supports * and ** wildcards.
 * Avoids pulling in a full minimatch dependency for basic ignore patterns.
 */
export function minimatch(filepath: string, pattern: string): boolean {
    const regex = patternToRegex(pattern);
    return regex.test(filepath);
}

function patternToRegex(pattern: string): RegExp {
    let re = '';
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i += 2;
                if (pattern[i] === '/') {
                    i++;
                }
                continue;
            }
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '.') {
            re += '\\.';
        } else {
            re += c;
        }
        i++;
    }
    return new RegExp(`^${re}$`);
}

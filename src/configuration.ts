/** 配置值在调用工具前校验，并复制数组，避免后续修改影响本次调用。 */
export function stringArray(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== 'string')) {
        throw new Error(`${name} must be an array of strings.`);
    }
    return [...value] as string[];
}

export function runArguments(program: string, options: unknown, args: unknown): string[] {
    const flags = stringArray(options, 'teal.run.options');
    const programArgs = stringArray(args, 'teal.run.args');
    if (flags.includes('--')) throw new Error('Use teal.run.args for program arguments; teal.run.options must not contain --.');
    return ['run', ...flags, program, '--', ...programArgs];
}

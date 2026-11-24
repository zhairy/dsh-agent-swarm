export const EXECUTION_LANGUAGES = ['python', 'node'];
export class ExecutionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ExecutionError';
        this.code = code;
    }
}
//# sourceMappingURL=runtime.js.map
import { AppError } from '../utils/AppError.js';

export const validate = (schema) => (req, res, next) => {
    try {
        schema.parse({
            body: req.body,
            query: req.query,
            params: req.params,
        });
        next();
    } catch (err) {
        const message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
        next(new AppError(message, 400));
    }
};

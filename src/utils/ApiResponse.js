export class ApiResponse {
    static success(res, data = null, message = "Success", status = 200) {
        return res.status(status).json({
            ok: true,
            data,
            message
        });
    }

    static error(res, message = "Error", status = 500, error = null) {
        return res.status(status).json({
            ok: false,
            message,
            error
        });
    }

    static created(res, data = null, message = "Created") {
        return this.success(res, data, message, 201);
    }
}

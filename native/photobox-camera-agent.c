#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <gphoto2/gphoto2.h>

static Camera *camera = NULL;
static GPContext *context = NULL;
static int camera_ready = 0;

static void json_string(const char *value) {
    const unsigned char *cursor = (const unsigned char *)(value ? value : "");
    putchar('"');
    while (*cursor) {
        switch (*cursor) {
            case '\\': fputs("\\\\", stdout); break;
            case '"': fputs("\\\"", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (*cursor < 0x20) printf("\\u%04x", (unsigned int)*cursor);
                else putchar(*cursor);
        }
        cursor++;
    }
    putchar('"');
}

static void respond(long id, int result, const char *path) {
    printf("{\"id\":%ld,\"ok\":%s,\"code\":%d,\"message\":",
        id, result >= GP_OK ? "true" : "false", result);
    json_string(result >= GP_OK ? "OK" : gp_result_as_string(result));
    if (path) {
        fputs(",\"path\":", stdout);
        json_string(path);
    }
    fputs("}\n", stdout);
    fflush(stdout);
}

static void close_camera(void) {
    if (camera) {
        if (camera_ready) gp_camera_exit(camera, context);
        gp_camera_free(camera);
    }
    camera = NULL;
    camera_ready = 0;
}

static int ensure_camera(void) {
    int result;
    if (camera_ready && camera) return GP_OK;

    close_camera();
    result = gp_camera_new(&camera);
    if (result < GP_OK) return result;

    result = gp_camera_init(camera, context);
    if (result < GP_OK) {
        close_camera();
        return result;
    }
    camera_ready = 1;
    return GP_OK;
}

static int capture_preview(const char *target) {
    CameraFile *file = NULL;
    int result = ensure_camera();
    if (result < GP_OK) return result;

    result = gp_file_new(&file);
    if (result >= GP_OK) result = gp_camera_capture_preview(camera, file, context);
    if (result >= GP_OK) result = gp_file_save(file, target);
    if (file) gp_file_unref(file);
    return result;
}

static int capture_photo(const char *target) {
    CameraFilePath camera_path;
    CameraFile *file = NULL;
    int result = ensure_camera();
    if (result < GP_OK) return result;

    memset(&camera_path, 0, sizeof(camera_path));
    result = gp_camera_capture(camera, GP_CAPTURE_IMAGE, &camera_path, context);
    if (result < GP_OK) return result;

    result = gp_file_new(&file);
    if (result >= GP_OK) {
        result = gp_camera_file_get(
            camera,
            camera_path.folder,
            camera_path.name,
            GP_FILE_TYPE_NORMAL,
            file,
            context
        );
    }
    if (result >= GP_OK) result = gp_file_save(file, target);
    if (file) gp_file_unref(file);

    if (result >= GP_OK) {
        /* Sama seperti capture-image-and-download: cegah kartu kamera penuh. */
        gp_camera_file_delete(camera, camera_path.folder, camera_path.name, context);
    }
    return result;
}

static int find_widget(CameraWidget *root, const char *key, CameraWidget **found) {
    const char *name = NULL;
    const char *label = NULL;
    int count;

    gp_widget_get_name(root, &name);
    gp_widget_get_label(root, &label);
    if ((name && strcmp(name, key) == 0) || (label && strcmp(label, key) == 0)) {
        *found = root;
        return GP_OK;
    }

    count = gp_widget_count_children(root);
    for (int index = 0; index < count; index++) {
        CameraWidget *child = NULL;
        if (gp_widget_get_child(root, index, &child) >= GP_OK
            && find_widget(child, key, found) >= GP_OK) {
            return GP_OK;
        }
    }
    return GP_ERROR_BAD_PARAMETERS;
}

static int set_config_value(const char *key, const char *value) {
    CameraWidget *root = NULL;
    CameraWidget *widget = NULL;
    CameraWidgetType type;
    int result = ensure_camera();
    if (result < GP_OK) return result;

    result = gp_camera_get_config(camera, &root, context);
    if (result < GP_OK) return result;
    result = find_widget(root, key, &widget);
    if (result < GP_OK) goto done;
    result = gp_widget_get_type(widget, &type);
    if (result < GP_OK) goto done;

    if (type == GP_WIDGET_TOGGLE || type == GP_WIDGET_DATE) {
        int number = atoi(value);
        result = gp_widget_set_value(widget, &number);
    } else if (type == GP_WIDGET_RANGE) {
        float number = strtof(value, NULL);
        result = gp_widget_set_value(widget, &number);
    } else if (type == GP_WIDGET_TEXT) {
        result = gp_widget_set_value(widget, value);
    } else if (type == GP_WIDGET_MENU || type == GP_WIDGET_RADIO) {
        const char *selected = NULL;
        int choices = gp_widget_count_choices(widget);
        for (int index = 0; index < choices; index++) {
            const char *choice = NULL;
            if (gp_widget_get_choice(widget, index, &choice) >= GP_OK
                && strcmp(choice, value) == 0) {
                selected = choice;
                break;
            }
        }
        if (!selected) {
            char *end = NULL;
            long index = strtol(value, &end, 10);
            if (end && *end == '\0' && index >= 0 && index < choices) {
                gp_widget_get_choice(widget, (int)index, &selected);
            }
        }
        result = selected ? gp_widget_set_value(widget, selected) : GP_ERROR_BAD_PARAMETERS;
    } else {
        result = GP_ERROR_NOT_SUPPORTED;
    }

    if (result >= GP_OK) result = gp_camera_set_config(camera, root, context);

done:
    if (root) gp_widget_free(root);
    return result;
}

int main(void) {
    char *line = NULL;
    size_t capacity = 0;

    setvbuf(stdout, NULL, _IOLBF, 0);
    context = gp_context_new();
    if (!context) return 1;

    while (getline(&line, &capacity, stdin) >= 0) {
        char *save = NULL;
        char *id_text;
        char *command;
        char *arg1;
        char *arg2;
        long id;
        int result;

        line[strcspn(line, "\r\n")] = '\0';
        id_text = strtok_r(line, "\t", &save);
        command = strtok_r(NULL, "\t", &save);
        arg1 = strtok_r(NULL, "\t", &save);
        arg2 = strtok_r(NULL, "\t", &save);
        if (!id_text || !command) continue;
        id = strtol(id_text, NULL, 10);

        if (strcmp(command, "PING") == 0) {
            result = ensure_camera();
            respond(id, result, NULL);
        } else if (strcmp(command, "PREVIEW") == 0 && arg1) {
            result = capture_preview(arg1);
            respond(id, result, result >= GP_OK ? arg1 : NULL);
        } else if (strcmp(command, "CAPTURE") == 0 && arg1) {
            result = capture_photo(arg1);
            respond(id, result, result >= GP_OK ? arg1 : NULL);
        } else if (strcmp(command, "SET") == 0 && arg1 && arg2) {
            result = set_config_value(arg1, arg2);
            respond(id, result, NULL);
        } else if (strcmp(command, "RECONNECT") == 0) {
            close_camera();
            result = ensure_camera();
            respond(id, result, NULL);
        } else if (strcmp(command, "EXIT") == 0) {
            respond(id, GP_OK, NULL);
            break;
        } else {
            respond(id, GP_ERROR_BAD_PARAMETERS, NULL);
        }
    }

    free(line);
    close_camera();
    if (context) gp_context_unref(context);
    return 0;
}

(function() {
    'use strict';

    // ========== FLUID SIMULATION – dark version ==========
    let canvas = document.getElementById('fluidCanvas');
    let animationFrame = null;
    let gl, ext, config, pointers, splatStack;
    let textureWidth, textureHeight, velocity, divergence, curl, pressure;
    let lastTime, startTime;

    function initFluid() {
        if (!canvas) return;

        // Reinitialize all variables (in case canvas was replaced)
        pointers = [];
        splatStack = [];

        config = {
            TEXTURE_DOWNSAMPLE: 0,
            DENSITY_DISSIPATION: 0.98,
            VELOCITY_DISSIPATION: 0.99,
            PRESSURE_DISSIPATION: 0.85,
            PRESSURE_ITERATIONS: 20,
            CURL: 8,
            SPLAT_RADIUS: 0.004,
            DISTORTION_INTENSITY: 0.1,
            BLOB_SOFTNESS: 0.45
        };

        function getWebGLContext(canvas) {
            var params = { alpha: false, depth: false, stencil: false, antialias: true, preserveDrawingBuffer: false };
            var gl = canvas.getContext('webgl2', params);
            var isWebGL2 = !!gl;
            if (!isWebGL2) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

            var halfFloat = null;
            var supportLinearFiltering = null;
            if (isWebGL2) {
                gl.getExtension('EXT_color_buffer_float');
                supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
            } else {
                halfFloat = gl.getExtension('OES_texture_half_float');
                supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
            }

            gl.clearColor(0.0, 0.0, 0.0, 1.0);

            function supportRenderTextureFormat(internalFormat, format, type) {
                var texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

                var fbo = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

                var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                gl.deleteFramebuffer(fbo);
                gl.deleteTexture(texture);
                return status === gl.FRAMEBUFFER_COMPLETE;
            }

            function getSupportedFormat(internalFormat, format, type) {
                if (!supportRenderTextureFormat(internalFormat, format, type)) {
                    switch (internalFormat) {
                        case gl.R16F: return getSupportedFormat(gl.RG16F, gl.RG, type);
                        case gl.RG16F: return getSupportedFormat(gl.RGBA16F, gl.RGBA, type);
                        default: return null;
                    }
                }
                return { internalFormat: internalFormat, format: format };
            }

            var halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : (halfFloat ? halfFloat.HALF_FLOAT_OES : null);
            if (!halfFloatTexType) {
                console.warn('Half float textures not supported, falling back to byte format. Effect may look less smooth.');
            }

            var formatRGBA = getSupportedFormat(isWebGL2 ? gl.RGBA16F : gl.RGBA, gl.RGBA, halfFloatTexType);
            var formatRG = getSupportedFormat(isWebGL2 ? gl.RG16F : gl.RGBA, gl.RG, halfFloatTexType);
            var formatR = getSupportedFormat(isWebGL2 ? gl.R16F : gl.RGBA, gl.RED, halfFloatTexType);

            return {
                gl: gl,
                ext: {
                    formatRGBA: formatRGBA,
                    formatRG: formatRG,
                    formatR: formatR,
                    halfFloatTexType: halfFloatTexType,
                    supportLinearFiltering: supportLinearFiltering
                }
            };
        }

        function pointerPrototype() {
            this.id = -1;
            this.x = 0;
            this.y = 0;
            this.dx = 0;
            this.dy = 0;
            this.down = false;
            this.moved = false;
            this.color = [0.5, 0.5, 0.5];
        }

        pointers.push(new pointerPrototype());

        var _getWebGLContext = getWebGLContext(canvas);
        gl = _getWebGLContext.gl;
        ext = _getWebGLContext.ext;

        var GLProgram = function () {
            function GLProgram(vertexShader, fragmentShader) {
                this.uniforms = {};
                this.program = gl.createProgram();

                gl.attachShader(this.program, vertexShader);
                gl.attachShader(this.program, fragmentShader);
                gl.linkProgram(this.program);

                if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw gl.getProgramInfoLog(this.program);

                var uniformCount = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
                for (var i = 0; i < uniformCount; i++) {
                    var uniformName = gl.getActiveUniform(this.program, i).name;
                    this.uniforms[uniformName] = gl.getUniformLocation(this.program, uniformName);
                }
            }

            GLProgram.prototype.bind = function () {
                gl.useProgram(this.program);
            };

            return GLProgram;
        }();

        function compileShader(type, source) {
            var shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);

            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(shader);

            return shader;
        }

        var baseVertexShader = compileShader(gl.VERTEX_SHADER, `
            precision highp float;
            attribute vec2 aPosition;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform vec2 texelSize;
            void main () {
                vUv = aPosition * 0.5 + 0.5;
                vL = vUv - vec2(texelSize.x, 0.0);
                vR = vUv + vec2(texelSize.x, 0.0);
                vT = vUv + vec2(0.0, texelSize.y);
                vB = vUv - vec2(0.0, texelSize.y);
                gl_Position = vec4(aPosition, 0.0, 1.0);
            }
        `);

        var gradientDisplayShaderSource = `
            precision highp float;
            precision mediump sampler2D;

            varying vec2 vUv;
            uniform sampler2D uVelocity;
            uniform float uTime;
            uniform float uDistortionIntensity;
            uniform float uBlobSoftness;
            uniform vec2 uResolution;

            float blob(vec2 uv, vec2 center, float radius, float softness) {
                vec2 d = uv - center;
                float r = length(d);
                return exp(-r * r / (radius * radius * (1.0 - softness * 0.6)));
            }

            void main() {
                vec2 velocity = texture2D(uVelocity, vUv).xy;
                vec2 distortedUV = vUv + velocity * uDistortionIntensity * 0.04;

                float time = uTime * 0.001;

                vec2 center1 = vec2(0.25 + sin(time * 0.3) * 0.1, 0.5 + cos(time * 0.4) * 0.1);
                vec2 center2 = vec2(0.75 + sin(time * 0.35 + 2.0) * 0.1, 0.5 + cos(time * 0.45 + 1.5) * 0.1);

                vec3 color1 = vec3(0.412, 0.427, 0.627); // #696da0
                vec3 color2 = vec3(0.800, 0.318, 0.439); // #cc5170

                float blob1 = blob(distortedUV, center1, 0.25, uBlobSoftness);
                float blob2 = blob(distortedUV, center2, 0.23, uBlobSoftness);

                float total = blob1 + blob2 + 0.001;
                vec3 blended = (blob1 * color1 + blob2 * color2) / total;

                vec2 uvCentered = vUv - 0.5;
                float vignette = 1.0 - dot(uvCentered, uvCentered) * 0.6;
                vignette = pow(vignette, 0.9);
                blended *= vignette;

                float mask = clamp(total * 0.8, 0.0, 1.0);
                vec3 finalColor = mix(vec3(0.0), blended, mask);

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `;

        var gradientDisplayShader = compileShader(gl.FRAGMENT_SHADER, gradientDisplayShaderSource);

        // Other shaders (abbreviated – same as before) ...
        var clearShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uTexture;
            uniform float value;
            void main () { gl_FragColor = value * texture2D(uTexture, vUv); }
        `);
        var splatShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uTarget;
            uniform float aspectRatio;
            uniform vec3 color;
            uniform vec2 point;
            uniform float radius;
            void main () {
                vec2 p = vUv - point.xy;
                p.x *= aspectRatio;
                vec3 splat = exp(-dot(p, p) / radius) * color;
                vec3 base = texture2D(uTarget, vUv).xyz;
                gl_FragColor = vec4(base + splat, 1.0);
            }
        `);
        var advectionManualFilteringShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uVelocity;
            uniform sampler2D uSource;
            uniform vec2 texelSize;
            uniform float dt;
            uniform float dissipation;
            vec4 bilerp (in sampler2D sam, in vec2 p) {
                vec4 st;
                st.xy = floor(p - 0.5) + 0.5;
                st.zw = st.xy + 1.0;
                vec4 uv = st * texelSize.xyxy;
                vec4 a = texture2D(sam, uv.xy);
                vec4 b = texture2D(sam, uv.zy);
                vec4 c = texture2D(sam, uv.xw);
                vec4 d = texture2D(sam, uv.zw);
                vec2 f = p - st.xy;
                return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            }
            void main () {
                vec2 coord = gl_FragCoord.xy - dt * texture2D(uVelocity, vUv).xy;
                gl_FragColor = dissipation * bilerp(uSource, coord);
                gl_FragColor.a = 1.0;
            }
        `);
        var advectionShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            uniform sampler2D uVelocity;
            uniform sampler2D uSource;
            uniform vec2 texelSize;
            uniform float dt;
            uniform float dissipation;
            void main () {
                vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
                gl_FragColor = dissipation * texture2D(uSource, coord);
                gl_FragColor.a = 1.0;
            }
        `);
        var divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uVelocity;
            vec2 sampleVelocity (in vec2 uv) {
                vec2 multiplier = vec2(1.0, 1.0);
                if (uv.x < 0.0) { uv.x = 0.0; multiplier.x = -1.0; }
                if (uv.x > 1.0) { uv.x = 1.0; multiplier.x = -1.0; }
                if (uv.y < 0.0) { uv.y = 0.0; multiplier.y = -1.0; }
                if (uv.y > 1.0) { uv.y = 1.0; multiplier.y = -1.0; }
                return multiplier * texture2D(uVelocity, uv).xy;
            }
            void main () {
                float L = sampleVelocity(vL).x;
                float R = sampleVelocity(vR).x;
                float T = sampleVelocity(vT).y;
                float B = sampleVelocity(vB).y;
                float div = 0.5 * (R - L + T - B);
                gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
            }
        `);
        var curlShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uVelocity;
            void main () {
                float L = texture2D(uVelocity, vL).y;
                float R = texture2D(uVelocity, vR).y;
                float T = texture2D(uVelocity, vT).x;
                float B = texture2D(uVelocity, vB).x;
                float vorticity = R - L - T + B;
                gl_FragColor = vec4(vorticity, 0.0, 0.0, 1.0);
            }
        `);
        var vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uVelocity;
            uniform sampler2D uCurl;
            uniform float curl;
            uniform float dt;
            void main () {
                float T = texture2D(uCurl, vT).x;
                float B = texture2D(uCurl, vB).x;
                float C = texture2D(uCurl, vUv).x;
                vec2 force = vec2(abs(T) - abs(B), 0.0);
                force *= 1.0 / length(force + 0.00001) * curl * C;
                vec2 vel = texture2D(uVelocity, vUv).xy;
                gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
            }
        `);
        var pressureShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uPressure;
            uniform sampler2D uDivergence;
            vec2 boundary (in vec2 uv) { uv = min(max(uv, 0.0), 1.0); return uv; }
            void main () {
                float L = texture2D(uPressure, boundary(vL)).x;
                float R = texture2D(uPressure, boundary(vR)).x;
                float T = texture2D(uPressure, boundary(vT)).x;
                float B = texture2D(uPressure, boundary(vB)).x;
                float C = texture2D(uPressure, vUv).x;
                float divergence = texture2D(uDivergence, vUv).x;
                float pressure = (L + R + B + T - divergence) * 0.25;
                gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
            }
        `);
        var gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uPressure;
            uniform sampler2D uVelocity;
            vec2 boundary (in vec2 uv) { uv = min(max(uv, 0.0), 1.0); return uv; }
            void main () {
                float L = texture2D(uPressure, boundary(vL)).x;
                float R = texture2D(uPressure, boundary(vR)).x;
                float T = texture2D(uPressure, boundary(vT)).x;
                float B = texture2D(uPressure, boundary(vB)).x;
                vec2 velocity = texture2D(uVelocity, vUv).xy;
                velocity.xy -= vec2(R - L, T - B);
                gl_FragColor = vec4(velocity, 0.0, 1.0);
            }
        `);

        function initFramebuffers() {
            textureWidth = gl.drawingBufferWidth >> config.TEXTURE_DOWNSAMPLE;
            textureHeight = gl.drawingBufferHeight >> config.TEXTURE_DOWNSAMPLE;

            var texType = ext.halfFloatTexType;
            var rgba = ext.formatRGBA;
            var rg = ext.formatRG;
            var r = ext.formatR;

            velocity = createDoubleFBO(0, textureWidth, textureHeight, rg.internalFormat, rg.format, texType, ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST);
            divergence = createFBO(4, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
            curl = createFBO(5, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
            pressure = createDoubleFBO(6, textureWidth, textureHeight, r.internalFormat, r.format, texType, gl.NEAREST);
        }

        function createFBO(texId, w, h, internalFormat, format, type, param) {
            gl.activeTexture(gl.TEXTURE0 + texId);
            var texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

            var fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            gl.viewport(0, 0, w, h);
            gl.clear(gl.COLOR_BUFFER_BIT);

            return [texture, fbo, texId];
        }

        function createDoubleFBO(texId, w, h, internalFormat, format, type, param) {
            var fbo1 = createFBO(texId, w, h, internalFormat, format, type, param);
            var fbo2 = createFBO(texId + 1, w, h, internalFormat, format, type, param);

            return {
                get read() { return fbo1; },
                get write() { return fbo2; },
                swap: function () { var temp = fbo1; fbo1 = fbo2; fbo2 = temp; }
            };
        }

        var blit = (function () {
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(0);

            return function (destination) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
                gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
            };
        })();

        var clearProgram = new GLProgram(baseVertexShader, clearShader);
        var gradientDisplayProgram = new GLProgram(baseVertexShader, gradientDisplayShader);
        var splatProgram = new GLProgram(baseVertexShader, splatShader);
        var advectionProgram = new GLProgram(baseVertexShader, ext.supportLinearFiltering ? advectionShader : advectionManualFilteringShader);
        var divergenceProgram = new GLProgram(baseVertexShader, divergenceShader);
        var curlProgram = new GLProgram(baseVertexShader, curlShader);
        var vorticityProgram = new GLProgram(baseVertexShader, vorticityShader);
        var pressureProgram = new GLProgram(baseVertexShader, pressureShader);
        var gradientSubtractProgram = new GLProgram(baseVertexShader, gradientSubtractShader);

        initFramebuffers();

        lastTime = Date.now();
        startTime = Date.now();

        function update() {
            resizeCanvas();

            var currentTime = Date.now();
            var dt = Math.min((currentTime - lastTime) / 1000, 0.016);
            lastTime = currentTime;

            gl.viewport(0, 0, textureWidth, textureHeight);

            if (pointers.every(p => !p.down)) {
                var t = currentTime * 0.001;
                var forceX = Math.sin(t * 0.5) * 0.01;
                var forceY = Math.cos(t * 0.3) * 0.01;
                splatVelocity(canvas.width * 0.5, canvas.height * 0.5, forceX, forceY);
            }

            advectionProgram.bind();
            gl.uniform2f(advectionProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
            gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read[2]);
            gl.uniform1i(advectionProgram.uniforms.uSource, velocity.read[2]);
            gl.uniform1f(advectionProgram.uniforms.dt, dt);
            gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
            blit(velocity.write[1]);
            velocity.swap();

            for (var i = 0; i < pointers.length; i++) {
                var pointer = pointers[i];
                if (pointer.moved) {
                    splatVelocity(pointer.x, pointer.y, pointer.dx * 0.3, pointer.dy * 0.3);
                    pointer.moved = false;
                }
            }

            curlProgram.bind();
            gl.uniform2f(curlProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
            gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read[2]);
            blit(curl[1]);

            vorticityProgram.bind();
            gl.uniform2f(vorticityProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
            gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read[2]);
            gl.uniform1i(vorticityProgram.uniforms.uCurl, curl[2]);
            gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
            gl.uniform1f(vorticityProgram.uniforms.dt, dt);
            blit(velocity.write[1]);
            velocity.swap();

            divergenceProgram.bind();
            gl.uniform2f(divergenceProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
            gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read[2]);
            blit(divergence[1]);

            clearProgram.bind();
            var pressureTexId = pressure.read[2];
            gl.activeTexture(gl.TEXTURE0 + pressureTexId);
            gl.bindTexture(gl.TEXTURE_2D, pressure.read[0]);
            gl.uniform1i(clearProgram.uniforms.uTexture, pressureTexId);
            gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE_DISSIPATION);
            blit(pressure.write[1]);
            pressure.swap();

            pressureProgram.bind();
            gl.uniform2f(pressureProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
            gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence[2]);
            pressureTexId = pressure.read[2];
            gl.uniform1i(pressureProgram.uniforms.uPressure, pressureTexId);
            gl.activeTexture(gl.TEXTURE0 + pressureTexId);
            for (var _i = 0; _i < config.PRESSURE_ITERATIONS; _i++) {
                gl.bindTexture(gl.TEXTURE_2D, pressure.read[0]);
                blit(pressure.write[1]);
                pressure.swap();
            }

            gradientSubtractProgram.bind();
            gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, 1.0 / textureWidth, 1.0 / textureHeight);
            gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read[2]);
            gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read[2]);
            blit(velocity.write[1]);
            velocity.swap();

            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gradientDisplayProgram.bind();
            gl.activeTexture(gl.TEXTURE0 + velocity.read[2]);
            gl.bindTexture(gl.TEXTURE_2D, velocity.read[0]);
            gl.uniform1i(gradientDisplayProgram.uniforms.uVelocity, velocity.read[2]);
            gl.uniform1f(gradientDisplayProgram.uniforms.uTime, currentTime - startTime);
            gl.uniform1f(gradientDisplayProgram.uniforms.uDistortionIntensity, config.DISTORTION_INTENSITY);
            gl.uniform1f(gradientDisplayProgram.uniforms.uBlobSoftness, config.BLOB_SOFTNESS);
            gl.uniform2f(gradientDisplayProgram.uniforms.uResolution, canvas.width, canvas.height);
            blit(null);

            animationFrame = requestAnimationFrame(update);
        }

        function splatVelocity(x, y, dx, dy) {
            splatProgram.bind();
            gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read[2]);
            gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
            gl.uniform2f(splatProgram.uniforms.point, x / canvas.width, 1.0 - y / canvas.height);
            gl.uniform3f(splatProgram.uniforms.color, dx, -dy, 1.0);
            gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS);
            blit(velocity.write[1]);
            velocity.swap();
        }

        function resizeCanvas() {
            if (canvas.width != canvas.clientWidth || canvas.height != canvas.clientHeight) {
                canvas.width = canvas.clientWidth;
                canvas.height = canvas.clientHeight;
                initFramebuffers();
            }
        }

        canvas.addEventListener('mouseenter', (e) => {
            pointers[0].down = true;
            pointers[0].moved = false;
            pointers[0].x = e.offsetX;
            pointers[0].y = e.offsetY;
            pointers[0].dx = 0;
            pointers[0].dy = 0;
        });

        canvas.addEventListener('mousemove', (e) => {
            pointers[0].moved = pointers[0].down;
            pointers[0].dx = (e.offsetX - pointers[0].x) * 2.0;
            pointers[0].dy = (e.offsetY - pointers[0].y) * 2.0;
            pointers[0].x = e.offsetX;
            pointers[0].y = e.offsetY;
        });

        canvas.addEventListener('mouseleave', () => {
            pointers[0].down = false;
            pointers[0].moved = false;
        });

        canvas.addEventListener('touchmove', function (e) {
            e.preventDefault();
            var touches = e.targetTouches;
            for (var i = 0; i < touches.length; i++) {
                var pointer = pointers[i];
                pointer.moved = pointer.down;
                pointer.dx = (touches[i].pageX - pointer.x) * 2.0;
                pointer.dy = (touches[i].pageY - pointer.y) * 2.0;
                pointer.x = touches[i].pageX;
                pointer.y = touches[i].pageY;
            }
        }, false);

        canvas.addEventListener('touchstart', function (e) {
            e.preventDefault();
            var touches = e.targetTouches;
            for (var i = 0; i < touches.length; i++) {
                if (i >= pointers.length) pointers.push(new pointerPrototype());

                pointers[i].id = touches[i].identifier;
                pointers[i].down = true;
                pointers[i].x = touches[i].pageX;
                pointers[i].y = touches[i].pageY;
            }
        });

        window.addEventListener('touchend', function (e) {
            var touches = e.changedTouches;
            for (var i = 0; i < touches.length; i++) {
                for (var j = 0; j < pointers.length; j++) {
                    if (touches[i].identifier == pointers[j].id) pointers[j].down = false;
                }
            }
        });

        window.addEventListener('resize', function () {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            initFramebuffers();
        });

        // Start animation
        animationFrame = requestAnimationFrame(update);
    }

    function stopFluid() {
        if (animationFrame) {
            cancelAnimationFrame(animationFrame);
            animationFrame = null;
        }
        // Remove event listeners if needed (we'll rely on reinitialization)
    }

    // ========== ELASTIC LINES ==========
    function initElasticLine(wrapperId, lineId, svgWidth = 200, svgHeight = 12, attractorRange = 50) {
        const wrapper = document.getElementById(wrapperId);
        const linePaths = document.querySelectorAll(`#${lineId} .line`);
        if (!wrapper || !linePaths.length) return;

        let initialPath = `M0,6 Q${svgWidth/2},6 ${svgWidth},6`;
        let lastMouseOutside = true;

        function updateLine(clientX, clientY) {
            const rect = wrapper.getBoundingClientRect();
            const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;

            if (inside) {
                lastMouseOutside = false;
                const relX = clientX - rect.left;
                const width = rect.width;
                const t = Math.min(1, Math.max(0, relX / width));
                const ctrlX = t * svgWidth;
                const centerY = svgHeight / 2;
                const attractY = clientY - rect.top;
                if (Math.abs(attractY - centerY) < attractorRange) {
                    const newPath = `M0,${centerY} Q${ctrlX},${attractY} ${svgWidth},${centerY}`;
                    linePaths.forEach(line => line.setAttribute('d', newPath));
                } else {
                    if (linePaths[0].getAttribute('d') !== initialPath) {
                        TweenMax.to(linePaths[0], 0.3, {attr: {d: initialPath}, ease: Power2.easeOut});
                        TweenMax.to(linePaths[1], 0.3, {attr: {d: initialPath}, ease: Power2.easeOut});
                    }
                }
            } else {
                if (!lastMouseOutside) {
                    lastMouseOutside = true;
                    TweenMax.to(linePaths[0], 0.5, {attr: {d: initialPath}, ease: Elastic.easeOut.config(1, 0.3)});
                    TweenMax.to(linePaths[1], 0.5, {attr: {d: initialPath}, ease: Elastic.easeOut.config(1, 0.3)});
                }
            }
        }

        document.addEventListener('mousemove', (e) => updateLine(e.clientX, e.clientY));
        document.addEventListener('touchmove', (e) => {
            if (e.touches.length) updateLine(e.touches[0].clientX, e.touches[0].clientY);
        });
        document.addEventListener('touchend', () => updateLine(-1000, -1000));
    }

    // ========== PORTFOLIO INTERACTIONS ==========
    function initPortfolio() {
        // Marketing, photography and instagram are auto-generated by generate-marketing.js

        // Photography 3D cube – dynamic, works with any number of images
        const imageContainerEl = document.querySelector(".image-container");
        const prevEl = document.getElementById("prev");
        const nextEl = document.getElementById("next");

        if (imageContainerEl && prevEl && nextEl) {
            const spans = Array.from(imageContainerEl.querySelectorAll('span'));
            const count = spans.length;
            if (count === 0) return;

            // Use actual rendered size so mobile matches desktop perfectly
            const faceSize = imageContainerEl.offsetWidth || 300;
            const angle = 360 / count;
            const radius = Math.round((faceSize / 2) / Math.tan(Math.PI / count) * 1.5);

            spans.forEach((span, i) => {
                span.style.width = faceSize + 'px';
                span.style.height = faceSize + 'px';
                span.style.transform = `rotateY(${i * angle}deg) translateZ(${radius}px)`;
            });

            let currentIndex = 0;
            function updateCube(index) {
                currentIndex = ((index % count) + count) % count;
                imageContainerEl.style.transform = `rotateY(${-currentIndex * angle}deg)`;
                // Mobile: highlight active face, dim the rest
                spans.forEach((s, i) => s.classList.toggle('face-active', i === currentIndex));
            }
            updateCube(0);

            prevEl.addEventListener("click", () => updateCube(currentIndex - 1));
            nextEl.addEventListener("click", () => updateCube(currentIndex + 1));

            // Swipe support for mobile
            let touchStartX = 0;
            imageContainerEl.addEventListener('touchstart', e => {
                touchStartX = e.touches[0].clientX;
            }, { passive: true });
            imageContainerEl.addEventListener('touchend', e => {
                const diff = touchStartX - e.changedTouches[0].clientX;
                if (Math.abs(diff) > 40) {
                    diff > 0 ? updateCube(currentIndex + 1) : updateCube(currentIndex - 1);
                }
            }, { passive: true });
        }

        const instagramGallery = document.querySelector('.instagram-gallery');
        if (instagramGallery) {
            const imgCElements = instagramGallery.querySelectorAll('.instagram-img-c');

            imgCElements.forEach((imgC) => {
                imgC.addEventListener('click', function() {
                    if (this.classList.contains('active')) return;

                    const w = this.offsetWidth;
                    const h = this.offsetHeight;
                    const x = this.getBoundingClientRect().left + window.scrollX;
                    const y = this.getBoundingClientRect().top + window.scrollY;

                    document.querySelectorAll('.instagram-img-c.active').forEach(el => {
                        el.classList.remove('active');
                        el.classList.add('postactive');
                        setTimeout(() => {
                            if (el.classList.contains('postactive')) {
                                el.classList.remove('postactive');
                            }
                        }, 500);
                    });

                    const copy = this.cloneNode(true);
                    copy.style.width = w + 'px';
                    copy.style.height = h + 'px';
                    copy.style.position = 'fixed';
                    copy.style.top = y + 'px';
                    copy.style.left = x + 'px';
                    copy.classList.add('active');

                    document.body.appendChild(copy);

                    setTimeout(() => {
                        copy.classList.add('positioned');
                        copy.style.width = '100%';
                        copy.style.height = '100%';
                        copy.style.top = '0';
                        copy.style.left = '0';
                        copy.style.transition = 'all ease 400ms';
                    }, 0);

                    copy.addEventListener('click', function(e) {
                        if (e.target === this || e.target.closest('.instagram-img-w')) {
                            this.classList.remove('positioned', 'active');
                            this.classList.add('postactive');
                            setTimeout(() => {
                                this.remove();
                            }, 500);
                        }
                    });
                });
            });
        }

        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
            video.addEventListener('mouseenter', () => {
                video.play();
            });
            video.addEventListener('mouseleave', () => {
                video.pause();
                video.currentTime = 0;
            });
            video.addEventListener('touchstart', () => {
                video.play();
            });
            video.addEventListener('touchend', () => {
                video.pause();
                video.currentTime = 0;
            });
        });

        const contactForm = document.getElementById('new-contact-form');
        if (contactForm && !contactForm.dataset.listenerAttached) {
            contactForm.dataset.listenerAttached = 'true';
            contactForm.addEventListener('submit', function(e) {
                e.preventDefault();

                const name = document.querySelector('input[name="name"]').value;
                const email = document.querySelector('input[name="email"]').value;
                const message = document.querySelector('textarea[name="message"]').value;

                if (!name || !email || !message) {
                    alert('Please fill in all required fields');
                    return;
                }

                const formData = new FormData(this);

                fetch(this.action, {
                    method: 'POST',
                    body: formData,
                    headers: { 'Accept': 'application/json' }
                })
                .then(response => {
                    if (response.ok) {
                        alert('Thank you for your message! I will get back to you soon.');
                        this.reset();
                        document.querySelectorAll('.floating-label-group select').forEach(s => s.selectedIndex = 0);
                    } else {
                        alert('There was an error sending your message. Please try again.');
                    }
                })
                .catch(error => {
                    console.error('Error:', error);
                    alert('There was an error sending your message. Please try again.');
                });
            });
        }

        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                e.preventDefault();

                const targetId = this.getAttribute('href');
                if (targetId === '#') return;

                const targetElement = document.querySelector(targetId);
                if (targetElement) {
                    window.scrollTo({
                        top: targetElement.offsetTop - 80,
                        behavior: 'smooth'
                    });
                }
            });
        });

        window.addEventListener("scroll", () => {
            let current = "";
            const sections = document.querySelectorAll("section[id], div[id='home']");
            sections.forEach(section => {
                const sectionTop = section.offsetTop;
                if (window.scrollY >= (sectionTop - 150)) {
                    current = section.getAttribute("id");
                }
            });
            document.querySelectorAll(".nav a").forEach(link => {
                const href = link.getAttribute("href");
                if (href && href.startsWith("#")) {
                    const sectionId = href.substring(1);
                    link.classList.toggle("active", sectionId === current);
                }
            });
        });

        document.querySelectorAll('.nav a, .btn, .contact-btn, .instagram-img-c, .animation-card, .portfolio-card, .dev-item, .footer a').forEach(element => {
            element.addEventListener('mousedown', function(e) {
                e.stopPropagation();
            });
            element.addEventListener('touchstart', function(e) {
                e.stopPropagation();
            });
        });

        // Add style for Instagram zoom
        const style = document.createElement('style');
        style.textContent = `
            .instagram-img-c.active {
                position: fixed !important;
                z-index: 1000 !important;
                cursor: zoom-out !important;
            }
            .instagram-img-c.positioned {
                width: 100% !important;
                height: 100% !important;
                top: 0 !important;
                left: 0 !important;
                border-radius: 0 !important;
                border: none !important;
            }
            .instagram-img-c.postactive {
                opacity: 0;
                transform: scale(0.8);
            }
            .touch-active {
                transform: scale(0.98) !important;
                opacity: 0.9 !important;
            }
            @media (hover: none) and (pointer: coarse) {
                .btn:active, .contact-btn:active,
                .instagram-img-c:active, .animation-card:active, .portfolio-card:active, .dev-item:active {
                    transform: scale(0.98) !important;
                    transition: transform 0.1s ease !important;
                }
                #fluidCanvas {
                    -webkit-transform: translateZ(0);
                    transform: translateZ(0);
                    -webkit-backface-visibility: hidden;
                    backface-visibility: hidden;
                }
            }
        `;
        document.head.appendChild(style);
    }

    function observeContact() {
        const contactSection = document.querySelector('.contact-section');
        if (contactSection) {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                    }
                });
            }, { threshold: 0.2 });
            observer.observe(contactSection);
        }
    }

    // ========== MOBILE-ONLY FEATURES ==========
    let mobileCleanup = null;

    function initMobileFeatures() {
        if (window.innerWidth >= 768) return null;

        const navUl = document.querySelector('.nav ul');
        const closeMenu = () => navUl?.classList.remove('show');

        // Scroll fade-in animations (no parallax)
        const animatedElements = document.querySelectorAll(`
            .section-title, .bio-text p, .bio-image,
            .animation-card, .portfolio-card, .dev-item,
            .instagram-img-c, .contact-left h2, .contact-left p,
            .contact-email-wrapper, .contact-form-container,
            .main-name, .signature, .tagline
        `);
        animatedElements.forEach(el => el.classList.add('animate-mobile'));

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.15, rootMargin: '0px 0px -30px 0px' });

        animatedElements.forEach(el => observer.observe(el));

        // Cleanup function
        return () => {
            if (navUl) navUl.classList.remove('show');
            observer.disconnect();
            animatedElements.forEach(el => {
                el.classList.remove('animate-mobile', 'visible');
            });
        };
    }

    // ========== PRICING DRAWER ==========
    function initPricingDrawer() {
        const attachListener = (btn, drw) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                drw.classList.toggle('open');
                btn.classList.toggle('open');
            });
        };

        const btn = document.getElementById('pricingToggle');
        const drw = document.getElementById('pricingDrawer');

        if (btn && drw) {
            attachListener(btn, drw);
            return;
        }

        // If elements aren't found yet, observe DOM for their addition
        const observer = new MutationObserver((mutations, obs) => {
            const newBtn = document.getElementById('pricingToggle');
            const newDrw = document.getElementById('pricingDrawer');
            if (newBtn && newDrw) {
                attachListener(newBtn, newDrw);
                obs.disconnect();
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Fallback: stop observing after 5 seconds to avoid memory leaks
        setTimeout(() => observer.disconnect(), 5000);
    }

    // ========== EXPORT ==========
    // ========== YOUTUBE CLICK-TO-PLAY ==========
    function initYouTube() {
        document.querySelectorAll('.yt-thumb').forEach(function(thumb) {
            thumb.addEventListener('click', function() {
                var id = thumb.dataset.id;
                var iframe = document.createElement('iframe');
                iframe.src = 'https://www.youtube-nocookie.com/embed/' + id
                           + '?autoplay=1&rel=0&modestbranding=1&playsinline=1';
                iframe.allow = 'autoplay; fullscreen';
                iframe.allowFullscreen = true;
                iframe.style.position = 'absolute';
                iframe.style.inset = '0';
                iframe.style.width = '100%';
                iframe.style.height = '100%';
                iframe.style.border = 'none';
                thumb.innerHTML = '';
                thumb.appendChild(iframe);
            });
        });
    }

    window.__currentTheme = {
        init: function() {
            console.log('Dark theme init');
            initFluid();
            initPortfolio();
            initElasticLine('emailWrapper', 'elasticLineEmail');
            initElasticLine('btnWrapper', 'elasticLineBtn');
            observeContact();
            mobileCleanup = initMobileFeatures();
            initPricingDrawer();
            initYouTube();
        },
        destroy: function() {
            console.log('Dark theme destroy');
            stopFluid();
            if (mobileCleanup) mobileCleanup();
        }
    };
})();
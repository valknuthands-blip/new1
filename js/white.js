(function() {
    'use strict';

    // ========== FLUID SIMULATION – light version (your original code) ==========
    let canvas = document.getElementById('fluidCanvas');
    let animationFrame = null;

    // Store original event listeners so we can remove them on destroy
    let boundListeners = [];

    function initFluidSimulation() {
        if (!canvas) return;

        const noiseOverlay = document.getElementById('noiseOverlay');
        const zoneCenter = document.getElementById('zoneCenter');
        const zoneNav = document.getElementById('zoneNav');
        const zoneContent = document.getElementById('zoneContent');

        let textureAnimationTimeout;
        let isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        let touchForceMultiplier = isTouchDevice ? 2.0 : 1.0;

        function resizeCanvas() {
            let width = scaleByPixelRatio(canvas.clientWidth);
            let height = scaleByPixelRatio(canvas.clientHeight);
            if (canvas.width != width || canvas.height != height) {
                canvas.width = width;
                canvas.height = height;
                return true;
            }
            return false;
        }

        let config = {
            SIM_RESOLUTION: 64,
            DYE_RESOLUTION: 512,
            CAPTURE_RESOLUTION: 256,
            DENSITY_DISSIPATION: 1.5,
            VELOCITY_DISSIPATION: 0.3,
            PRESSURE: 0.02,
            PRESSURE_ITERATIONS: 10,
            CURL: 0.5,
            SPLAT_RADIUS: 0.06,
            SPLAT_FORCE: 3000,
            SHADING: false,
            COLORFUL: true,
            COLOR_UPDATE_SPEED: 5,
            PAUSED: false,
            BACK_COLOR: { r: 255, g: 255, b: 255 },
            TRANSPARENT: false,
            BLOOM: false,
            BLOOM_ITERATIONS: 4,
            BLOOM_RESOLUTION: 128,
            BLOOM_INTENSITY: 0.4,
            BLOOM_THRESHOLD: 0.4,
            BLOOM_SOFT_KNEE: 0.5,
            SUNRAYS: false,
            SUNRAYS_RESOLUTION: 128,
            SUNRAYS_WEIGHT: 0.5,
        }

        function pointerPrototype () {
            this.id = -1;
            this.texcoordX = 0;
            this.texcoordY = 0;
            this.prevTexcoordX = 0;
            this.prevTexcoordY = 0;
            this.deltaX = 0;
            this.deltaY = 0;
            this.down = false;
            this.moved = false;
            this.color = generateColor();
        }

        let pointers = [];
        let splatStack = [];
        pointers.push(new pointerPrototype());

        resizeCanvas();

        const { gl, ext } = getWebGLContext(canvas);

        if (isMobile()) {
            config.DYE_RESOLUTION = 256;
            config.SPLAT_RADIUS = 0.08;
            config.SPLAT_FORCE = 4000;
        }
        if (!ext.supportLinearFiltering) {
            config.DYE_RESOLUTION = 256;
            config.SHADING = false;
            config.BLOOM = false;
            config.SUNRAYS = false;
        }

        function startCustomGUI() {
            if (typeof dat !== 'undefined') {
                var gui = new dat.GUI({ width: 180 });
                gui.add({ fun: () => {
                    splatStack.push(parseInt(Math.random() * 10) + 2);
                } }, 'fun').name('Random Splats');
                gui.close();
            }
        }
        startCustomGUI();

        function checkInteractiveZones(x, y) {
            const zones = [zoneCenter, zoneNav, zoneContent];
            return zones.some(zone => {
                const rect = zone.getBoundingClientRect();
                return x >= rect.left && x <= rect.right && 
                       y >= rect.top && y <= rect.bottom;
            });
        }

        function activateTextureAnimation() {
            if (noiseOverlay) {
                noiseOverlay.classList.add('active');
                if (textureAnimationTimeout) clearTimeout(textureAnimationTimeout);
            }
        }

        function deactivateTextureAnimation() {
            if (noiseOverlay) {
                textureAnimationTimeout = setTimeout(() => {
                    noiseOverlay.classList.remove('active');
                }, 300);
            }
        }

        function getWebGLContext (canvas) {
            const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
            let gl = canvas.getContext('webgl2', params);
            const isWebGL2 = !!gl;
            if (!isWebGL2)
                gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
            let halfFloat;
            let supportLinearFiltering;
            if (isWebGL2) {
                gl.getExtension('EXT_color_buffer_float');
                supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
            } else {
                halfFloat = gl.getExtension('OES_texture_half_float');
                supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
            }
            gl.clearColor(1.0, 1.0, 1.0, 1.0);
            const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
            let formatRGBA;
            let formatRG;
            let formatR;
            if (isWebGL2) {
                formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
                formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
                formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
            } else {
                formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
                formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
                formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
            }
            return {
                gl,
                ext: {
                    formatRGBA,
                    formatRG,
                    formatR,
                    halfFloatTexType,
                    supportLinearFiltering
                }
            };
        }

        function getSupportedFormat (gl, internalFormat, format, type) {
            if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
                switch (internalFormat) {
                    case gl.R16F:
                        return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
                    case gl.RG16F:
                        return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
                    default:
                        return null;
                }
            }
            return { internalFormat, format };
        }

        function supportRenderTextureFormat (gl, internalFormat, format, type) {
            let texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
            let fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            return status == gl.FRAMEBUFFER_COMPLETE;
        }

        function isMobile () {
            return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        }

        class Material {
            constructor (vertexShader, fragmentShaderSource) {
                this.vertexShader = vertexShader;
                this.fragmentShaderSource = fragmentShaderSource;
                this.programs = [];
                this.activeProgram = null;
                this.uniforms = [];
            }
            setKeywords (keywords) {
                let hash = 0;
                for (let i = 0; i < keywords.length; i++)
                    hash += hashCode(keywords[i]);
                let program = this.programs[hash];
                if (program == null) {
                    let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
                    program = createProgram(this.vertexShader, fragmentShader);
                    this.programs[hash] = program;
                }
                if (program == this.activeProgram) return;
                this.uniforms = getUniforms(program);
                this.activeProgram = program;
            }
            bind () {
                gl.useProgram(this.activeProgram);
            }
        }

        class Program {
            constructor (vertexShader, fragmentShader) {
                this.uniforms = {};
                this.program = createProgram(vertexShader, fragmentShader);
                this.uniforms = getUniforms(this.program);
            }
            bind () {
                gl.useProgram(this.program);
            }
        }

        function createProgram (vertexShader, fragmentShader) {
            let program = gl.createProgram();
            gl.attachShader(program, vertexShader);
            gl.attachShader(program, fragmentShader);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
                console.trace(gl.getProgramInfoLog(program));
            return program;
        }

        function getUniforms (program) {
            let uniforms = [];
            let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            for (let i = 0; i < uniformCount; i++) {
                let uniformName = gl.getActiveUniform(program, i).name;
                uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
            }
            return uniforms;
        }

        function compileShader (type, source, keywords) {
            source = addKeywords(source, keywords);
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                console.trace(gl.getShaderInfoLog(shader));
            return shader;
        }

        function addKeywords (source, keywords) {
            if (keywords == null) return source;
            let keywordsString = '';
            keywords.forEach(keyword => {
                keywordsString += '#define ' + keyword + '\n';
            });
            return keywordsString + source;
        }

        const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
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

        const blurVertexShader = compileShader(gl.VERTEX_SHADER, `
            precision highp float;
            attribute vec2 aPosition;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            uniform vec2 texelSize;
            void main () {
                vUv = aPosition * 0.5 + 0.5;
                float offset = 1.33333333;
                vL = vUv - texelSize * offset;
                vR = vUv + texelSize * offset;
                gl_Position = vec4(aPosition, 0.0, 1.0);
            }
        `);

        const blurShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            uniform sampler2D uTexture;
            void main () {
                vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
                sum += texture2D(uTexture, vL) * 0.35294117;
                sum += texture2D(uTexture, vR) * 0.35294117;
                gl_FragColor = sum;
            }
        `);

        const copyShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            uniform sampler2D uTexture;
            void main () {
                gl_FragColor = texture2D(uTexture, vUv);
            }
        `);

        const clearShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            uniform sampler2D uTexture;
            uniform float value;
            void main () {
                gl_FragColor = value * texture2D(uTexture, vUv);
            }
        `);

        const colorShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            uniform vec4 color;
            void main () {
                gl_FragColor = color;
            }
        `);

        const checkerboardShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            uniform sampler2D uTexture;
            uniform float aspectRatio;
            #define SCALE 25.0
            void main () {
                vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
                float v = mod(uv.x + uv.y, 2.0);
                v = v * 0.1 + 0.8;
                gl_FragColor = vec4(vec3(v), 1.0);
            }
        `);

        const displayShaderSource = `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uTexture;
            uniform sampler2D uBloom;
            uniform sampler2D uSunrays;
            uniform sampler2D uDithering;
            uniform vec2 ditherScale;
            uniform vec2 texelSize;
            vec3 linearToGamma (vec3 color) {
                color = max(color, vec3(0));
                return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
            }
            void main () {
                vec3 c = texture2D(uTexture, vUv).rgb;
            #ifdef SHADING
                vec3 lc = texture2D(uTexture, vL).rgb;
                vec3 rc = texture2D(uTexture, vR).rgb;
                vec3 tc = texture2D(uTexture, vT).rgb;
                vec3 bc = texture2D(uTexture, vB).rgb;
                float dx = length(rc) - length(lc);
                float dy = length(tc) - length(bc);
                vec3 n = normalize(vec3(dx, dy, length(texelSize)));
                vec3 l = vec3(0.0, 0.0, 1.0);
                float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
                c *= diffuse;
            #endif
            #ifdef BLOOM
                vec3 bloom = texture2D(uBloom, vUv).rgb;
            #endif
            #ifdef SUNRAYS
                float sunrays = texture2D(uSunrays, vUv).r;
                c *= sunrays;
            #ifdef BLOOM
                bloom *= sunrays;
            #endif
            #endif
            #ifdef BLOOM
                float noise = texture2D(uDithering, vUv * ditherScale).r;
                noise = noise * 2.0 - 1.0;
                bloom += noise / 255.0;
                bloom = linearToGamma(bloom);
                c += bloom;
            #endif
                float a = max(c.r, max(c.g, c.b));
                gl_FragColor = vec4(c, a);
            }
        `;

        const bloomPrefilterShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying vec2 vUv;
            uniform sampler2D uTexture;
            uniform vec3 curve;
            uniform float threshold;
            void main () {
                vec3 c = texture2D(uTexture, vUv).rgb;
                float br = max(c.r, max(c.g, c.b));
                float rq = clamp(br - curve.x, 0.0, curve.y);
                rq = curve.z * rq * rq;
                c *= max(rq, br - threshold) / max(br, 0.0001);
                gl_FragColor = vec4(c, 0.0);
            }
        `);

        const bloomBlurShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uTexture;
            void main () {
                vec4 sum = vec4(0.0);
                sum += texture2D(uTexture, vL);
                sum += texture2D(uTexture, vR);
                sum += texture2D(uTexture, vT);
                sum += texture2D(uTexture, vB);
                sum *= 0.25;
                gl_FragColor = sum;
            }
        `);

        const bloomFinalShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uTexture;
            uniform float intensity;
            void main () {
                vec4 sum = vec4(0.0);
                sum += texture2D(uTexture, vL);
                sum += texture2D(uTexture, vR);
                sum += texture2D(uTexture, vT);
                sum += texture2D(uTexture, vB);
                sum *= 0.25;
                gl_FragColor = sum * intensity;
            }
        `);

        const sunraysMaskShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            uniform sampler2D uTexture;
            void main () {
                vec4 c = texture2D(uTexture, vUv);
                float br = max(c.r, max(c.g, c.b));
                c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);
                gl_FragColor = c;
            }
        `);

        const sunraysShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            uniform sampler2D uTexture;
            uniform float weight;
            #define ITERATIONS 16
            void main () {
                float Density = 0.3;
                float Decay = 0.95;
                float Exposure = 0.7;
                vec2 coord = vUv;
                vec2 dir = vUv - 0.5;
                dir *= 1.0 / float(ITERATIONS) * Density;
                float illuminationDecay = 1.0;
                float color = texture2D(uTexture, vUv).a;
                for (int i = 0; i < ITERATIONS; i++) {
                    coord -= dir;
                    float col = texture2D(uTexture, coord).a;
                    color += col * illuminationDecay * weight;
                    illuminationDecay *= Decay;
                }
                gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
            }
        `);

        const splatShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
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

        const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            uniform sampler2D uVelocity;
            uniform sampler2D uSource;
            uniform vec2 texelSize;
            uniform vec2 dyeTexelSize;
            uniform float dt;
            uniform float dissipation;
            vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
                vec2 st = uv / tsize - 0.5;
                vec2 iuv = floor(st);
                vec2 fuv = fract(st);
                vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
                vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
                vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
                vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
                return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
            }
            void main () {
            #ifdef MANUAL_FILTERING
                vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
                vec4 result = bilerp(uSource, coord, dyeTexelSize);
            #else
                vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
                vec4 result = texture2D(uSource, coord);
            #endif
                float decay = 1.0 + dissipation * dt;
                gl_FragColor = result / decay;
            }`, ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']
        );

        const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            varying highp vec2 vL;
            varying highp vec2 vR;
            varying highp vec2 vT;
            varying highp vec2 vB;
            uniform sampler2D uVelocity;
            void main () {
                float L = texture2D(uVelocity, vL).x;
                float R = texture2D(uVelocity, vR).x;
                float T = texture2D(uVelocity, vT).y;
                float B = texture2D(uVelocity, vB).y;
                vec2 C = texture2D(uVelocity, vUv).xy;
                if (vL.x < 0.0) { L = -C.x; }
                if (vR.x > 1.0) { R = -C.x; }
                if (vT.y > 1.0) { T = -C.y; }
                if (vB.y < 0.0) { B = -C.y; }
                float div = 0.5 * (R - L + T - B);
                gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
            }
        `);

        const curlShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            varying highp vec2 vL;
            varying highp vec2 vR;
            varying highp vec2 vT;
            varying highp vec2 vB;
            uniform sampler2D uVelocity;
            void main () {
                float L = texture2D(uVelocity, vL).y;
                float R = texture2D(uVelocity, vR).y;
                float T = texture2D(uVelocity, vT).x;
                float B = texture2D(uVelocity, vB).x;
                float vorticity = R - L - T + B;
                gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
            }
        `);

        const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            precision highp sampler2D;
            varying vec2 vUv;
            varying vec2 vL;
            varying vec2 vR;
            varying vec2 vT;
            varying vec2 vB;
            uniform sampler2D uVelocity;
            uniform sampler2D uCurl;
            uniform float curl;
            uniform float dt;
            void main () {
                float L = texture2D(uCurl, vL).x;
                float R = texture2D(uCurl, vR).x;
                float T = texture2D(uCurl, vT).x;
                float B = texture2D(uCurl, vB).x;
                float C = texture2D(uCurl, vUv).x;
                vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
                force /= length(force) + 0.0001;
                force *= curl * C;
                force.y *= -1.0;
                vec2 velocity = texture2D(uVelocity, vUv).xy;
                velocity += force * dt;
                velocity = min(max(velocity, -1000.0), 1000.0);
                gl_FragColor = vec4(velocity, 0.0, 1.0);
            }
        `);

        const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            varying highp vec2 vL;
            varying highp vec2 vR;
            varying highp vec2 vT;
            varying highp vec2 vB;
            uniform sampler2D uPressure;
            uniform sampler2D uDivergence;
            void main () {
                float L = texture2D(uPressure, vL).x;
                float R = texture2D(uPressure, vR).x;
                float T = texture2D(uPressure, vT).x;
                float B = texture2D(uPressure, vB).x;
                float C = texture2D(uPressure, vUv).x;
                float divergence = texture2D(uDivergence, vUv).x;
                float pressure = (L + R + B + T - divergence) * 0.25;
                gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
            }
        `);

        const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
            precision mediump float;
            precision mediump sampler2D;
            varying highp vec2 vUv;
            varying highp vec2 vL;
            varying highp vec2 vR;
            varying highp vec2 vT;
            varying highp vec2 vB;
            uniform sampler2D uPressure;
            uniform sampler2D uVelocity;
            void main () {
                float L = texture2D(uPressure, vL).x;
                float R = texture2D(uPressure, vR).x;
                float T = texture2D(uPressure, vT).x;
                float B = texture2D(uPressure, vB).x;
                vec2 velocity = texture2D(uVelocity, vUv).xy;
                velocity.xy -= vec2(R - L, T - B);
                gl_FragColor = vec4(velocity, 0.0, 1.0);
            }
        `);

        const blit = (() => {
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(0);
            return (target, clear = false) => {
                if (target == null) {
                    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                } else {
                    gl.viewport(0, 0, target.width, target.height);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
                }
                if (clear) {
                    gl.clearColor(0.0, 0.0, 0.0, 1.0);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                }
                gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
            };
        })();

        let dye;
        let velocity;
        let divergence;
        let curl;
        let pressure;
        let bloom;
        let bloomFramebuffers = [];
        let sunrays;
        let sunraysTemp;

        let ditheringTexture = createTextureAsync('https://raw.githubusercontent.com/PavelDoGreat/WebGL-Fluid-Simulation/master/textures/LDR_LLL1_0.png');

        const blurProgram            = new Program(blurVertexShader, blurShader);
        const copyProgram            = new Program(baseVertexShader, copyShader);
        const clearProgram           = new Program(baseVertexShader, clearShader);
        const colorProgram           = new Program(baseVertexShader, colorShader);
        const checkerboardProgram    = new Program(baseVertexShader, checkerboardShader);
        const bloomPrefilterProgram  = new Program(baseVertexShader, bloomPrefilterShader);
        const bloomBlurProgram       = new Program(baseVertexShader, bloomBlurShader);
        const bloomFinalProgram      = new Program(baseVertexShader, bloomFinalShader);
        const sunraysMaskProgram     = new Program(baseVertexShader, sunraysMaskShader);
        const sunraysProgram         = new Program(baseVertexShader, sunraysShader);
        const splatProgram           = new Program(baseVertexShader, splatShader);
        const advectionProgram       = new Program(baseVertexShader, advectionShader);
        const divergenceProgram      = new Program(baseVertexShader, divergenceShader);
        const curlProgram            = new Program(baseVertexShader, curlShader);
        const vorticityProgram       = new Program(baseVertexShader, vorticityShader);
        const pressureProgram        = new Program(baseVertexShader, pressureShader);
        const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

        const displayMaterial = new Material(baseVertexShader, displayShaderSource);

        function initFramebuffers () {
            let simRes = getResolution(config.SIM_RESOLUTION);
            let dyeRes = getResolution(config.DYE_RESOLUTION);
            const texType = ext.halfFloatTexType;
            const rgba    = ext.formatRGBA;
            const rg      = ext.formatRG;
            const r       = ext.formatR;
            const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
            gl.disable(gl.BLEND);
            if (dye == null)
                dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
            else
                dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
            if (velocity == null)
                velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
            else
                velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
            divergence = createFBO      (simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
            curl       = createFBO      (simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
            pressure   = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
            initBloomFramebuffers();
            initSunraysFramebuffers();
        }

        function initBloomFramebuffers () {
            let res = getResolution(config.BLOOM_RESOLUTION);
            const texType = ext.halfFloatTexType;
            const rgba = ext.formatRGBA;
            const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
            bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);
            bloomFramebuffers.length = 0;
            for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
                let width = res.width >> (i + 1);
                let height = res.height >> (i + 1);
                if (width < 2 || height < 2) break;
                let fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
                bloomFramebuffers.push(fbo);
            }
        }

        function initSunraysFramebuffers () {
            let res = getResolution(config.SUNRAYS_RESOLUTION);
            const texType = ext.halfFloatTexType;
            const r = ext.formatR;
            const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
            sunrays     = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
            sunraysTemp = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
        }

        function createFBO (w, h, internalFormat, format, type, param) {
            gl.activeTexture(gl.TEXTURE0);
            let texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
            let fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            gl.viewport(0, 0, w, h);
            gl.clear(gl.COLOR_BUFFER_BIT);
            let texelSizeX = 1.0 / w;
            let texelSizeY = 1.0 / h;
            return {
                texture,
                fbo,
                width: w,
                height: h,
                texelSizeX,
                texelSizeY,
                attach (id) {
                    gl.activeTexture(gl.TEXTURE0 + id);
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    return id;
                }
            };
        }

        function createDoubleFBO (w, h, internalFormat, format, type, param) {
            let fbo1 = createFBO(w, h, internalFormat, format, type, param);
            let fbo2 = createFBO(w, h, internalFormat, format, type, param);
            return {
                width: w,
                height: h,
                texelSizeX: fbo1.texelSizeX,
                texelSizeY: fbo1.texelSizeY,
                get read () { return fbo1; },
                set read (value) { fbo1 = value; },
                get write () { return fbo2; },
                set write (value) { fbo2 = value; },
                swap () { let temp = fbo1; fbo1 = fbo2; fbo2 = temp; }
            };
        }

        function resizeFBO (target, w, h, internalFormat, format, type, param) {
            let newFBO = createFBO(w, h, internalFormat, format, type, param);
            copyProgram.bind();
            gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
            blit(newFBO);
            return newFBO;
        }

        function resizeDoubleFBO (target, w, h, internalFormat, format, type, param) {
            if (target.width == w && target.height == h) return target;
            target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
            target.write = createFBO(w, h, internalFormat, format, type, param);
            target.width = w;
            target.height = h;
            target.texelSizeX = 1.0 / w;
            target.texelSizeY = 1.0 / h;
            return target;
        }

        function createTextureAsync (url) {
            let texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]));
            let obj = {
                texture,
                width: 1,
                height: 1,
                attach (id) {
                    gl.activeTexture(gl.TEXTURE0 + id);
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    return id;
                }
            };
            let image = new Image();
            image.onload = () => {
                obj.width = image.width;
                obj.height = image.height;
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
            };
            image.src = url;
            return obj;
        }

        function updateKeywords () {
            let displayKeywords = [];
            if (config.SHADING) displayKeywords.push("SHADING");
            if (config.BLOOM) displayKeywords.push("BLOOM");
            if (config.SUNRAYS) displayKeywords.push("SUNRAYS");
            displayMaterial.setKeywords(displayKeywords);
        }

        updateKeywords();
        initFramebuffers();
        multipleSplats(parseInt(Math.random() * 5) + 2);

        let lastUpdateTime = Date.now();
        let colorUpdateTimer = 0.0;

        function update () {
            const dt = calcDeltaTime();
            if (resizeCanvas()) initFramebuffers();
            updateColors(dt);
            applyInputs();
            if (!config.PAUSED) step(dt);
            render(null);
            animationFrame = requestAnimationFrame(update);
        }

        function calcDeltaTime () {
            let now = Date.now();
            let dt = (now - lastUpdateTime) / 1000;
            dt = Math.min(dt, 0.016666);
            lastUpdateTime = now;
            return dt;
        }

        function updateColors (dt) {
            if (!config.COLORFUL) return;
            colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
            if (colorUpdateTimer >= 1) {
                colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
                pointers.forEach(p => { p.color = generateColor(); });
            }
        }

        function applyInputs () {
            if (splatStack.length > 0) multipleSplats(splatStack.pop());
            pointers.forEach(p => {
                if (p.moved) {
                    p.moved = false;
                    splatPointer(p);
                }
            });
        }

        function step (dt) {
            gl.disable(gl.BLEND);
            curlProgram.bind();
            gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
            gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
            blit(curl);
            vorticityProgram.bind();
            gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
            gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
            gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
            gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
            gl.uniform1f(vorticityProgram.uniforms.dt, dt);
            blit(velocity.write);
            velocity.swap();
            divergenceProgram.bind();
            gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
            gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
            blit(divergence);
            clearProgram.bind();
            gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
            gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
            blit(pressure.write);
            pressure.swap();
            pressureProgram.bind();
            gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
            gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
            for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
                gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
                blit(pressure.write);
                pressure.swap();
            }
            gradienSubtractProgram.bind();
            gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
            gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
            gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
            blit(velocity.write);
            velocity.swap();
            advectionProgram.bind();
            gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
            if (!ext.supportLinearFiltering)
                gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
            let velocityId = velocity.read.attach(0);
            gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
            gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
            gl.uniform1f(advectionProgram.uniforms.dt, dt);
            gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
            blit(velocity.write);
            velocity.swap();
            if (!ext.supportLinearFiltering)
                gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
            gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
            gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
            gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
            blit(dye.write);
            dye.swap();
        }

        function render (target) {
            if (config.BLOOM) applyBloom(dye.read, bloom);
            if (config.SUNRAYS) {
                applySunrays(dye.read, dye.write, sunrays);
                blur(sunrays, sunraysTemp, 1);
            }
            if (target == null || !config.TRANSPARENT) {
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                gl.enable(gl.BLEND);
            } else {
                gl.disable(gl.BLEND);
            }
            if (!config.TRANSPARENT) drawColor(target, normalizeColor(config.BACK_COLOR));
            if (target == null && config.TRANSPARENT) drawCheckerboard(target);
            drawDisplay(target);
        }

        function drawColor (target, color) {
            colorProgram.bind();
            gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
            blit(target);
        }

        function drawCheckerboard (target) {
            checkerboardProgram.bind();
            gl.uniform1f(checkerboardProgram.uniforms.aspectRatio, canvas.width / canvas.height);
            blit(target);
        }

        function drawDisplay (target) {
            let width = target == null ? gl.drawingBufferWidth : target.width;
            let height = target == null ? gl.drawingBufferHeight : target.height;
            displayMaterial.bind();
            if (config.SHADING) gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
            gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
            if (config.BLOOM) {
                gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
                gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
                let scale = getTextureScale(ditheringTexture, width, height);
                gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
            }
            if (config.SUNRAYS) gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
            blit(target);
        }

        function applyBloom (source, destination) {
            if (bloomFramebuffers.length < 2) return;
            let last = destination;
            gl.disable(gl.BLEND);
            bloomPrefilterProgram.bind();
            let knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
            let curve0 = config.BLOOM_THRESHOLD - knee;
            let curve1 = knee * 2;
            let curve2 = 0.25 / knee;
            gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
            gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
            gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
            blit(last);
            bloomBlurProgram.bind();
            for (let i = 0; i < bloomFramebuffers.length; i++) {
                let dest = bloomFramebuffers[i];
                gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
                gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
                blit(dest);
                last = dest;
            }
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.enable(gl.BLEND);
            for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
                let baseTex = bloomFramebuffers[i];
                gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
                gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
                gl.viewport(0, 0, baseTex.width, baseTex.height);
                blit(baseTex);
                last = baseTex;
            }
            gl.disable(gl.BLEND);
            bloomFinalProgram.bind();
            gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
            gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
            gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
            blit(destination);
        }

        function applySunrays (source, mask, destination) {
            gl.disable(gl.BLEND);
            sunraysMaskProgram.bind();
            gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
            blit(mask);
            sunraysProgram.bind();
            gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
            gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
            blit(destination);
        }

        function blur (target, temp, iterations) {
            blurProgram.bind();
            for (let i = 0; i < iterations; i++) {
                gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
                gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
                blit(temp);
                gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
                gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
                blit(target);
            }
        }

        function splatPointer (pointer) {
            let forceMultiplier = isTouchDevice ? touchForceMultiplier : 1.0;
            let dx = pointer.deltaX * config.SPLAT_FORCE * forceMultiplier;
            let dy = pointer.deltaY * config.SPLAT_FORCE * forceMultiplier;
            splat(pointer.texcoordX, pointer.texcoordY, dx, dy, pointer.color);
        }

        function multipleSplats (amount) {
            for (let i = 0; i < amount; i++) {
                const color = generateColor();
                color.r *= 5.0;
                color.g *= 5.0;
                color.b *= 5.0;
                const x = Math.random();
                const y = Math.random();
                const forceMultiplier = isTouchDevice ? 1.2 : 1.0;
                const dx = 500 * (Math.random() - 0.5) * forceMultiplier;
                const dy = 500 * (Math.random() - 0.5) * forceMultiplier;
                splat(x, y, dx, dy, color);
            }
        }

        function splat (x, y, dx, dy, color) {
            let radiusMultiplier = isTouchDevice ? 1.2 : 1.0;
            splatProgram.bind();
            gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
            gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
            gl.uniform2f(splatProgram.uniforms.point, x, y);
            gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
            gl.uniform1f(splatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100.0 * radiusMultiplier));
            blit(velocity.write);
            velocity.swap();
            gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
            gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
            blit(dye.write);
            dye.swap();
        }

        function correctRadius (radius) {
            let aspectRatio = canvas.width / canvas.height;
            if (aspectRatio > 1) radius *= aspectRatio;
            return radius;
        }

        // Store event listeners for cleanup (optional, but good practice)
        function addListenerWithCleanup(element, type, listener, options) {
            element.addEventListener(type, listener, options);
            boundListeners.push({ element, type, listener, options });
        }

        // Mouse events
        let isMouseOverCanvas = false;

        function onMouseEnter(e) { isMouseOverCanvas = true; }
        function onMouseLeave(e) { isMouseOverCanvas = false; pointers[0].down = false; pointers[0].moved = false; }
        function onMouseMove(e) {
            let pointer = pointers[0];
            if (!isMouseOverCanvas) return;
            pointer.down = true;
            let rect = canvas.getBoundingClientRect();
            let posX = scaleByPixelRatio(e.clientX - rect.left);
            let posY = scaleByPixelRatio(e.clientY - rect.top);
            updatePointerMoveData(pointer, posX, posY);
            if (checkInteractiveZones(e.clientX, e.clientY)) activateTextureAnimation();
            else deactivateTextureAnimation();
        }

        addListenerWithCleanup(canvas, 'mouseenter', onMouseEnter);
        addListenerWithCleanup(canvas, 'mouseleave', onMouseLeave);
        addListenerWithCleanup(canvas, 'mousemove', onMouseMove);

        function onTouchStart(e) {
            const touches = e.targetTouches;
            while (touches.length >= pointers.length) pointers.push(new pointerPrototype());
            for (let i = 0; i < touches.length; i++) {
                let touch = touches[i];
                let rect = canvas.getBoundingClientRect();
                let posX = scaleByPixelRatio(touch.clientX - rect.left);
                let posY = scaleByPixelRatio(touch.clientY - rect.top);
                updatePointerDownData(pointers[i + 1], touch.identifier, posX, posY);
                let pointer = pointers[i + 1];
                if (pointer.down) splatPointer(pointer);
                if (checkInteractiveZones(touch.clientX, touch.clientY)) activateTextureAnimation();
            }
        }
        addListenerWithCleanup(canvas, 'touchstart', onTouchStart, { passive: true });

        function onTouchMove(e) {
            const touches = e.targetTouches;
            for (let i = 0; i < touches.length; i++) {
                let touch = touches[i];
                let pointer = pointers[i + 1];
                if (!pointer) continue;
                let rect = canvas.getBoundingClientRect();
                let posX = scaleByPixelRatio(touch.clientX - rect.left);
                let posY = scaleByPixelRatio(touch.clientY - rect.top);
                updatePointerMoveData(pointer, posX, posY);
                if (pointer.down && pointer.moved) splatPointer(pointer);
                if (checkInteractiveZones(touch.clientX, touch.clientY)) activateTextureAnimation();
            }
        }
        addListenerWithCleanup(canvas, 'touchmove', onTouchMove, { passive: true });

        function onTouchEnd(e) {
            const touches = e.changedTouches;
            for (let i = 0; i < touches.length; i++) {
                let pointer = pointers.find(p => p.id == touches[i].identifier);
                if (pointer == null) continue;
                updatePointerUpData(pointer);
            }
            deactivateTextureAnimation();
        }
        addListenerWithCleanup(canvas, 'touchend', onTouchEnd);

        window.addEventListener('touchend', onTouchEnd); // global, but we'll keep simple

        function onKeyDown(e) {
            if (e.code === 'KeyP') config.PAUSED = !config.PAUSED;
            if (e.key === ' ') splatStack.push(parseInt(Math.random() * 5) + 1);
        }
        window.addEventListener('keydown', onKeyDown);
        boundListeners.push({ element: window, type: 'keydown', listener: onKeyDown });

        function updatePointerDownData (pointer, id, posX, posY) {
            pointer.id = id;
            pointer.down = true;
            pointer.moved = false;
            pointer.texcoordX = posX / canvas.width;
            pointer.texcoordY = 1.0 - posY / canvas.height;
            pointer.prevTexcoordX = pointer.texcoordX;
            pointer.prevTexcoordY = pointer.texcoordY;
            pointer.deltaX = 0;
            pointer.deltaY = 0;
            pointer.color = generateColor();
        }

        function updatePointerMoveData (pointer, posX, posY) {
            pointer.prevTexcoordX = pointer.texcoordX;
            pointer.prevTexcoordY = pointer.texcoordY;
            pointer.texcoordX = posX / canvas.width;
            pointer.texcoordY = 1.0 - posY / canvas.height;
            pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
            pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
            pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
        }

        function updatePointerUpData (pointer) { pointer.down = false; }

        function correctDeltaX (delta) {
            let aspectRatio = canvas.width / canvas.height;
            if (aspectRatio < 1) delta *= aspectRatio;
            return delta;
        }

        function correctDeltaY (delta) {
            let aspectRatio = canvas.width / canvas.height;
            if (aspectRatio > 1) delta /= aspectRatio;
            return delta;
        }

        function generateColor () {
            if (window.generateRandomColor) return window.generateRandomColor();
            const colors = [ { r: 0.0, g: 0.0, b: 0.0 }, { r: 0.533, g: 0.600, b: 0.980 } ];
            return colors[Math.floor(Math.random() * colors.length)];
        }

        function HSVtoRGB (h, s, v) {
            let r, g, b, i, f, p, q, t;
            i = Math.floor(h * 6);
            f = h * 6 - i;
            p = v * (1 - s);
            q = v * (1 - f * s);
            t = v * (1 - (1 - f) * s);
            switch (i % 6) {
                case 0: r = v; g = t; b = p; break;
                case 1: r = q; g = v; b = p; break;
                case 2: r = p; g = v; b = t; break;
                case 3: r = p; g = q; b = v; break;
                case 4: r = t; g = p; b = v; break;
                case 5: r = v; g = p; b = q; break;
            }
            return { r, g, b };
        }

        function normalizeColor (input) {
            return { r: input.r / 255, g: input.g / 255, b: input.b / 255 };
        }

        function wrap (value, min, max) {
            let range = max - min;
            if (range == 0) return min;
            return (value - min) % range + min;
        }

        function getResolution (resolution) {
            let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
            if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
            let min = Math.round(resolution);
            let max = Math.round(resolution * aspectRatio);
            if (gl.drawingBufferWidth > gl.drawingBufferHeight)
                return { width: max, height: min };
            else
                return { width: min, height: max };
        }

        function getTextureScale (texture, width, height) {
            return { x: width / texture.width, y: height / texture.height };
        }

        function scaleByPixelRatio (input) {
            let pixelRatio = window.devicePixelRatio || 1;
            return Math.floor(input * pixelRatio);
        }

        function hashCode (s) {
            if (s.length == 0) return 0;
            let hash = 0;
            for (let i = 0; i < s.length; i++) {
                hash = (hash << 5) - hash + s.charCodeAt(i);
                hash |= 0;
            }
            return hash;
        }

        function onResize() {
            resizeCanvas();
            initFramebuffers();
        }
        window.addEventListener('resize', onResize);
        boundListeners.push({ element: window, type: 'resize', listener: onResize });

        const interactiveZones = [zoneCenter, zoneNav, zoneContent];
        interactiveZones.forEach(zone => {
            if (zone) {
                function onEnter() { activateTextureAnimation(); }
                function onLeave() { deactivateTextureAnimation(); }
                zone.addEventListener('mouseenter', onEnter);
                zone.addEventListener('mouseleave', onLeave);
                zone.addEventListener('touchstart', onEnter);
                zone.addEventListener('touchend', onLeave);
                boundListeners.push({ element: zone, type: 'mouseenter', listener: onEnter });
                boundListeners.push({ element: zone, type: 'mouseleave', listener: onLeave });
                boundListeners.push({ element: zone, type: 'touchstart', listener: onEnter });
                boundListeners.push({ element: zone, type: 'touchend', listener: onLeave });
            }
        });

        // Start the animation loop
        animationFrame = requestAnimationFrame(update);
    }

    function stopFluid() {
        if (animationFrame) {
            cancelAnimationFrame(animationFrame);
            animationFrame = null;
        }
        // Remove all event listeners we added
        boundListeners.forEach(({ element, type, listener, options }) => {
            element.removeEventListener(type, listener, options);
        });
        boundListeners = [];
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

        // Store for cleanup
        const moveListener = (e) => updateLine(e.clientX, e.clientY);
        const touchMoveListener = (e) => {
            if (e.touches.length) updateLine(e.touches[0].clientX, e.touches[0].clientY);
        };
        const touchEndListener = () => updateLine(-1000, -1000);

        document.addEventListener('mousemove', moveListener);
        document.addEventListener('touchmove', touchMoveListener);
        document.addEventListener('touchend', touchEndListener);

        boundListeners.push({ element: document, type: 'mousemove', listener: moveListener });
        boundListeners.push({ element: document, type: 'touchmove', listener: touchMoveListener });
        boundListeners.push({ element: document, type: 'touchend', listener: touchEndListener });
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

            // Use actual rendered size so mobile matches desktop
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
                const clickHandler = function() {
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
                };
                imgC.addEventListener('click', clickHandler);
                // Store for cleanup if needed
            });
        }

        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
            video.addEventListener('mouseenter', () => { video.play(); });
            video.addEventListener('mouseleave', () => { video.pause(); video.currentTime = 0; });
            video.addEventListener('touchstart', () => { video.play(); });
            video.addEventListener('touchend', () => { video.pause(); video.currentTime = 0; });
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
            element.addEventListener('mousedown', function(e) { e.stopPropagation(); });
            element.addEventListener('touchstart', function(e) { e.stopPropagation(); });
        });

        // Add style for Instagram zoom (only once)
        if (!document.getElementById('instagram-zoom-style')) {
            const style = document.createElement('style');
            style.id = 'instagram-zoom-style';
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
            // Store observer for cleanup if needed (but theme switch destroys everything)
        }
    }

    // ===== COLOR GENERATOR FOR FLUID (blue/black) =====
    window.generateRandomColor = function() {
        const colors = [ { r: 0.0, g: 0.0, b: 0.0 }, { r: 0.533, g: 0.600, b: 0.980 } ];
        return colors[Math.floor(Math.random() * colors.length)];
    };

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
            console.log('Light theme init');
            document.body.style.opacity = '0';
            setTimeout(() => {
                document.body.style.transition = 'opacity 0.8s ease';
                document.body.style.opacity = '1';
            }, 100);
            initFluidSimulation();
            initPortfolio();
            initElasticLine('emailWrapper', 'elasticLineEmail');
            initElasticLine('btnWrapper', 'elasticLineBtn');
            observeContact();
            mobileCleanup = initMobileFeatures();
            initPricingDrawer();
            initYouTube();
        },
        destroy: function() {
            console.log('Light theme destroy');
            stopFluid();
            if (mobileCleanup) mobileCleanup();
        }
    };
})();
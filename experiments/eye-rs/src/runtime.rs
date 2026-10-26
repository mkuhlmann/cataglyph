// One signature of a LiteRT model, compiled for CPU or GPU, straight over litert-sys.
//
// Why not the safe `litert` crate (0.2.1): it keeps the raw handles of its options, model and
// environment private, so there is no way to attach accelerator options, and it exposes no
// signature or tensor names. Both matter here: Eye's outputs are found by name, and on Intel
// Arc (Mesa, Xe KMD) the WebGPU accelerator's default precision ran the whole graph and
// returned NaN in every output. The precision is a TOML payload in LiteRT's opaque options
// under the identifier "gpu_options" (litert/c/options/litert_gpu_options.h; the Lrt*
// helpers that build it are not exported by libLiteRt.so).

use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::path::Path;

use anyhow::{Context, Result, bail};
use litert_sys as sys;

fn check(status: sys::LiteRtStatus, what: &str) -> Result<()> {
    if status != sys::kLiteRtStatusOk {
        bail!("{what} failed (LiteRT status {status})");
    }
    Ok(())
}

unsafe fn string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

unsafe extern "C" fn free_cstring(ptr: *mut c_void) {
    if !ptr.is_null() {
        drop(unsafe { CString::from_raw(ptr as *mut c_char) });
    }
}

pub enum Accelerator {
    Cpu,
    /// `gpu_options` TOML, e.g. a precision override; None keeps LiteRT's defaults.
    Gpu(Option<String>),
}

struct Buffer {
    raw: sys::LiteRtTensorBuffer,
    floats: usize,
}

impl Buffer {
    fn for_tensor(env: sys::LiteRtEnvironment, tensor: sys::LiteRtTensor) -> Result<Self> {
        let mut ty = sys::LiteRtRankedTensorType::default();
        check(unsafe { sys::LiteRtGetRankedTensorType(tensor, &mut ty) }, "tensor type")?;
        if ty.element_type != sys::kLiteRtElementTypeFloat32 {
            bail!("only float32 tensors are supported (got element type {})", ty.element_type);
        }
        let rank = ty.layout.rank() as usize;
        let floats: usize = ty.layout.dimensions[..rank].iter().map(|&d| d.max(1) as usize).product();
        let mut raw: sys::LiteRtTensorBuffer = std::ptr::null_mut();
        check(
            unsafe {
                sys::LiteRtCreateManagedTensorBuffer(env, sys::kLiteRtTensorBufferTypeHostMemory, &ty, floats * 4, &mut raw)
            },
            "create tensor buffer",
        )?;
        Ok(Self { raw, floats })
    }

    fn with_lock<T>(&self, mode: sys::LiteRtTensorBufferLockMode, f: impl FnOnce(*mut f32) -> T) -> Result<T> {
        let mut ptr: *mut c_void = std::ptr::null_mut();
        check(unsafe { sys::LiteRtLockTensorBuffer(self.raw, &mut ptr, mode) }, "lock tensor buffer")?;
        let out = f(ptr as *mut f32);
        unsafe { sys::LiteRtUnlockTensorBuffer(self.raw) };
        Ok(out)
    }
}

impl Drop for Buffer {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { sys::LiteRtDestroyTensorBuffer(self.raw) }
        }
    }
}

pub struct Runtime {
    env: sys::LiteRtEnvironment,
    model: sys::LiteRtModel,
    compiled: sys::LiteRtCompiledModel,
    signature: sys::LiteRtParamIndex,
    input: Buffer,
    outputs: Vec<(String, Buffer)>,
}

impl Runtime {
    pub fn load(path: &Path, signature_key: &str, accelerator: &Accelerator) -> Result<Self> {
        let mut env: sys::LiteRtEnvironment = std::ptr::null_mut();
        check(unsafe { sys::LiteRtCreateEnvironment(0, std::ptr::null(), &mut env) }, "create environment")?;
        let mut rt = Self {
            env,
            model: std::ptr::null_mut(),
            compiled: std::ptr::null_mut(),
            signature: 0,
            // Placeholder until the signature is known; replaced below before any use.
            input: Buffer { raw: std::ptr::null_mut(), floats: 0 },
            outputs: Vec::new(),
        };

        let c_path = CString::new(path.to_string_lossy().as_bytes())?;
        check(unsafe { sys::LiteRtCreateModelFromFile(c_path.as_ptr(), &mut rt.model) }, "load model")?;

        let mut count: sys::LiteRtParamIndex = 0;
        check(unsafe { sys::LiteRtGetNumModelSignatures(rt.model, &mut count) }, "count signatures")?;
        let mut found = None;
        for i in 0..count {
            let mut sig: sys::LiteRtSignature = std::ptr::null_mut();
            check(unsafe { sys::LiteRtGetModelSignature(rt.model, i, &mut sig) }, "get signature")?;
            let mut key: *const c_char = std::ptr::null();
            check(unsafe { sys::LiteRtGetSignatureKey(sig, &mut key) }, "signature key")?;
            if unsafe { string(key) } == signature_key {
                found = Some((i, sig));
                break;
            }
        }
        let (index, sig) = found.with_context(|| format!("no `{signature_key}` signature"))?;
        rt.signature = index;

        let mut tensor: sys::LiteRtTensor = std::ptr::null_mut();
        check(unsafe { sys::LiteRtGetSignatureInputTensorByIndex(sig, 0, &mut tensor) }, "input tensor")?;
        rt.input = Buffer::for_tensor(env, tensor)?;
        let mut n_out: sys::LiteRtParamIndex = 0;
        check(unsafe { sys::LiteRtGetNumSignatureOutputs(sig, &mut n_out) }, "count outputs")?;
        for j in 0..n_out {
            let mut name: *const c_char = std::ptr::null();
            check(unsafe { sys::LiteRtGetSignatureOutputName(sig, j, &mut name) }, "output name")?;
            check(unsafe { sys::LiteRtGetSignatureOutputTensorByIndex(sig, j, &mut tensor) }, "output tensor")?;
            rt.outputs.push((unsafe { string(name) }, Buffer::for_tensor(env, tensor)?));
        }

        let mut options: sys::LiteRtOptions = std::ptr::null_mut();
        check(unsafe { sys::LiteRtCreateOptions(&mut options) }, "create options")?;
        let compiled = (|| {
            let hw = match accelerator {
                Accelerator::Cpu => sys::kLiteRtHwAcceleratorCpu,
                Accelerator::Gpu(_) => sys::kLiteRtHwAcceleratorGpu,
            };
            check(unsafe { sys::LiteRtSetOptionsHardwareAccelerators(options, hw as _) }, "set accelerators")?;
            if let Accelerator::Gpu(Some(toml)) = accelerator {
                let payload = CString::new(toml.as_str())?.into_raw();
                let mut opaque: sys::LiteRtOpaqueOptions = std::ptr::null_mut();
                check(
                    unsafe {
                        sys::LiteRtCreateOpaqueOptions(
                            c"gpu_options".as_ptr(),
                            payload as *mut c_void,
                            Some(free_cstring),
                            &mut opaque,
                        )
                    },
                    "create gpu options",
                )?;
                check(unsafe { sys::LiteRtAddOpaqueOptions(options, opaque) }, "add gpu options")?;
            }
            let mut compiled: sys::LiteRtCompiledModel = std::ptr::null_mut();
            check(unsafe { sys::LiteRtCreateCompiledModel(env, rt.model, options, &mut compiled) }, "compile model")?;
            Ok::<_, anyhow::Error>(compiled)
        })();
        unsafe { sys::LiteRtDestroyOptions(options) };
        rt.compiled = compiled?;
        Ok(rt)
    }

    /// Runs the signature. A run that "succeeds" with non-finite outputs is an error too:
    /// that is how the broken GPU path showed up with this LiteRT build.
    pub fn run(&mut self, input: &[f32]) -> Result<HashMap<String, Vec<f32>>> {
        if input.len() != self.input.floats {
            bail!("input holds {} floats, got {}", self.input.floats, input.len());
        }
        self.input.with_lock(sys::kLiteRtTensorBufferLockModeWrite, |ptr| unsafe {
            std::ptr::copy_nonoverlapping(input.as_ptr(), ptr, input.len());
        })?;
        let mut ins = [self.input.raw];
        let mut outs: Vec<sys::LiteRtTensorBuffer> = self.outputs.iter().map(|(_, b)| b.raw).collect();
        check(
            unsafe {
                sys::LiteRtRunCompiledModel(self.compiled, self.signature, 1, ins.as_mut_ptr(), outs.len(), outs.as_mut_ptr())
            },
            "run",
        )?;
        let mut result = HashMap::new();
        for (name, buffer) in &self.outputs {
            let values = buffer.with_lock(sys::kLiteRtTensorBufferLockModeRead, |ptr| unsafe {
                std::slice::from_raw_parts(ptr, buffer.floats).to_vec()
            })?;
            if values.iter().any(|v| !v.is_finite()) {
                bail!("output `{name}` is not finite (NaN/inf)");
            }
            result.insert(name.clone(), values);
        }
        Ok(result)
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        // Buffers and the compiled model before the model and environment they came from.
        self.outputs.clear();
        if !self.input.raw.is_null() {
            unsafe { sys::LiteRtDestroyTensorBuffer(self.input.raw) };
            self.input.raw = std::ptr::null_mut();
        }
        unsafe {
            if !self.compiled.is_null() {
                sys::LiteRtDestroyCompiledModel(self.compiled);
            }
            if !self.model.is_null() {
                sys::LiteRtDestroyModel(self.model);
            }
            sys::LiteRtDestroyEnvironment(self.env);
        }
    }
}

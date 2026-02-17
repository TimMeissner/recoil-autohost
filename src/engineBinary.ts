// SPDX-FileCopyrightText: 2026 The Recoil Autohost Authors
//
// SPDX-License-Identifier: Apache-2.0

export function engineBinaryName(): string {
	return process.platform === 'win32' ? 'spring-dedicated.exe' : 'spring-dedicated';
}

export function engineClientBinaryName(): string {
	return process.platform === 'win32' ? 'spring.exe' : 'spring';
}

export function engineHeadlessBinaryName(): string {
	return process.platform === 'win32' ? 'spring-headless.exe' : 'spring-headless';
}
